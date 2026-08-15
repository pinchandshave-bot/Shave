# Wiring instructions: domain persistence (Identity / Auth / Liabilities / Investments)

Apply these three patches. Everything referenced below is either a new file
(already provided) or an exact block to find-and-replace in the existing repo.

---

## 1. Run the migration

Run `migration_004_domain_persistence.sql` in the Supabase SQL editor,
against the same project Render's `DATABASE_URL` points at (confirm this —
see the note at the end of this doc about the earlier query mismatch).

---

## 2. Add the new file

Copy `domainPersistence.js` into `apps/api/src/domainPersistence.js`.

---

## 3. Patch `apps/api/src/sync.js`

### 3a. Add the import (near the top, with the other local requires)

FIND:
```js
const { decrypt } = require('./crypto');
```

REPLACE WITH:
```js
const { decrypt } = require('./crypto');

const {
  persistIdentity,
  persistAuth,
  persistLiabilities,
  persistInvestments,
} = require('./domainPersistence');
```

### 3b. Change `observeDomain`'s signature and persist after fetching

FIND:
```js
async function observeDomain(
  domain,
  accessToken,
  capability
) {
```

REPLACE WITH:
```js
async function observeDomain(
  domain,
  accessToken,
  capability,
  client,
  itemId
) {
```

### 3c. Persist each domain right after its Plaid fetch, before the `return`

FIND:
```js
    return {
      domain,
      state: 'observed',
      observed: true,
      observations:
        countDomainObservations(
          domain,
          data
        ),
      data,
    };
  } catch (error) {
```

REPLACE WITH:
```js
    let persistResult = null;

    try {
      switch (domain) {
        case 'identity':
          persistResult =
            await persistIdentity(
              client,
              itemId,
              data
            );
          break;

        case 'auth':
          persistResult =
            await persistAuth(
              client,
              itemId,
              data
            );
          break;

        case 'liabilities':
          persistResult =
            await persistLiabilities(
              client,
              itemId,
              data
            );
          break;

        case 'investments':
          persistResult =
            await persistInvestments(
              client,
              itemId,
              data
            );
          break;

        default:
          break;
      }
    } catch (persistError) {
      /*
       * A persistence failure is reported as an observation failure. It
       * must never be allowed to look like a successful write, and it
       * must never throw past this point — canonical transaction data
       * is already committed and cannot be affected by this.
       */
      console.error(
        [
          'Domain persistence failed.',
          `domain=${domain}`,
          `item=${itemId}`,
          persistError.message,
        ].join(' ')
      );

      return {
        domain,
        state: 'persistence_failed',
        observed: true,
        observations:
          countDomainObservations(
            domain,
            data
          ),
        error_message: persistError.message,
      };
    }

    return {
      domain,
      state: 'observed',
      observed: true,
      observations:
        persistResult?.observations ??
        countDomainObservations(
          domain,
          data
        ),
      persisted: persistResult,
    };
  } catch (error) {
```

Note: `data` is intentionally dropped from the final return object. The raw
Plaid payload for these domains includes account/routing numbers (auth) and
PII (identity) — it should not be echoed back in the sync API response body
once it's durably persisted. If you want the raw payload in the response for
debugging, gate it behind a non-production check rather than always
including it.

### 3d. Pass `client` and `itemId` through the call site in `synchronizeDomains`

FIND:
```js
  for (
    const domain
    of observationDomains
  ) {
    domains[domain] =
      await observeDomain(
        domain,
        accessToken,
        capabilities.domains[
          domain
        ]
      );
  }
```

REPLACE WITH:
```js
  for (
    const domain
    of observationDomains
  ) {
    domains[domain] =
      await observeDomain(
        domain,
        accessToken,
        capabilities.domains[
          domain
        ],
        client,
        itemId
      );
  }
```

That's the entire sync-side change. Everything else in `sync.js` — the
canonical transaction transaction, cursor advancement, rollback semantics —
is untouched. Domain persistence writes happen after `COMMIT`, using the
same already-open client, exactly where balance sync already writes.

---

## 4. Add read endpoints in `apps/api/src/me.js`

Add this function anywhere alongside the other exported handlers:

```js
async function getFinancialProfile(req, res) {
  try {
    const userId = req.user.id;

    const identityResult = await pool.query(
      `
        SELECT
          io.account_id,
          io.owner_index,
          io.names,
          io.emails,
          io.phone_numbers,
          io.addresses,
          io.updated_at
        FROM account_identity_owners io
        INNER JOIN accounts a ON a.id = io.account_id
        INNER JOIN plaid_items p ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
        ORDER BY io.account_id, io.owner_index
      `,
      [userId]
    );

    /*
     * Auth numbers are intentionally NOT decrypted here. This endpoint
     * only reports whether verified numbers are on file and the last
     * four digits, which is sufficient for a profile/trust-signal view.
     * Decryption should only ever happen in a narrowly scoped, audited
     * code path if/when a real money-movement feature needs it.
     */
    const authResult = await pool.query(
      `
        SELECT
          an.account_id,
          an.numbers_type,
          an.account_number_mask,
          (an.routing_number_encrypted IS NOT NULL) AS has_routing_number,
          (an.wire_routing_number_encrypted IS NOT NULL) AS has_wire_routing_number,
          an.updated_at
        FROM account_auth_numbers an
        INNER JOIN accounts a ON a.id = an.account_id
        INNER JOIN plaid_items p ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
      `,
      [userId]
    );

    const liabilitiesResult = await pool.query(
      `
        SELECT
          al.account_id,
          al.liability_type,
          al.is_overdue,
          al.last_payment_amount,
          al.last_payment_date,
          al.next_payment_due_date,
          al.minimum_payment_amount,
          al.last_statement_balance,
          al.interest_rate_percentage,
          al.updated_at,
          a.name AS account_name,
          a.mask AS account_mask
        FROM account_liabilities al
        INNER JOIN accounts a ON a.id = al.account_id
        INNER JOIN plaid_items p ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
        ORDER BY al.next_payment_due_date ASC NULLS LAST
      `,
      [userId]
    );

    const holdingsResult = await pool.query(
      `
        SELECT
          h.account_id,
          h.quantity,
          h.institution_price,
          h.institution_price_as_of,
          h.institution_value,
          h.cost_basis,
          h.iso_currency_code,
          s.ticker_symbol,
          s.name AS security_name,
          s.security_type,
          a.name AS account_name,
          a.mask AS account_mask
        FROM investment_holdings h
        INNER JOIN investment_securities s ON s.id = h.security_id
        INNER JOIN accounts a ON a.id = h.account_id
        INNER JOIN plaid_items p ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
        ORDER BY h.institution_value DESC NULLS LAST
      `,
      [userId]
    );

    const totalInvestmentValue = holdingsResult.rows.reduce(
      (sum, row) => sum + (Number(row.institution_value) || 0),
      0
    );

    const totalLiabilityBalance = liabilitiesResult.rows.reduce(
      (sum, row) => sum + (Number(row.last_statement_balance) || 0),
      0
    );

    return res.json({
      status: 'ok',

      identity: {
        owners: identityResult.rows,
      },

      auth: {
        accounts: authResult.rows,
      },

      liabilities: {
        accounts: liabilitiesResult.rows,
        total_balance: totalLiabilityBalance,
      },

      investments: {
        holdings: holdingsResult.rows,
        total_value: totalInvestmentValue,
      },
    });
  } catch (err) {
    console.error('Get financial profile failed:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Unable to load your financial profile',
    });
  }
}
```

Add `getFinancialProfile` to the `module.exports` block at the bottom of
`me.js`.

---

## 5. Add the route in `apps/api/src/index.js`

FIND:
```js
const {
  getMe,
  getDashboard,
  getSummary,
  getAccounts,
  getTransactions,
  getRoundups,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
} = require('./me');
```

REPLACE WITH:
```js
const {
  getMe,
  getDashboard,
  getSummary,
  getAccounts,
  getTransactions,
  getRoundups,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
  getFinancialProfile,
} = require('./me');
```

Then add the route near the other `/me/*` routes:

```js
app.get(
  "/me/profile",
  requireAuth,
  getFinancialProfile,
);
```

---

## What this gets you

Once deployed and a sync runs on an Item that's consented to Identity, Auth,
Liabilities, or Investments, `GET /me/profile` will return real, persisted
data for whichever of those four domains that Item actually has. Nothing is
inferred or backfilled for Items that haven't been re-synced since this
lands — the data only appears from the next sync forward.

## What's still explicitly not done

- **Statements** — requires blob storage for the PDF/JSON report itself;
  different shape of problem than the four above.
- **Recurring Transactions** — `plaidClient.js` doesn't export a wrapper for
  `transactionsRecurringGet` yet; needs to be added there first.
- **Assets / Income** — both are specialized async report-generation flows
  in Plaid (create report → poll/webhook → fetch report), not a single
  synchronous `get` call like the four built here. Real scope, not a
  same-pattern extension.
- **Frontend rendering** — nothing in `frontend/app/dashboard/page.tsx`
  consumes `/me/profile` yet. The API returns real data now; the UI to show
  it is a separate, frontend-only piece of work.

## One open item from earlier in this thread

The last few diagnostic queries against `sync_runs`, `accounts`, and
`transactions` returned mutually inconsistent results (an account ID pulled
directly from that item's own `accounts` table matched zero transaction
rows). That's still unresolved and is worth 30 seconds of checking before
trusting any further query results: confirm the Supabase SQL editor session
is connected to the same project Render's `DATABASE_URL` points at, not a
different project or branch.
