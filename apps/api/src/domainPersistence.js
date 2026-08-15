const { encrypt } = require('./crypto');

/*
 * ==========================================================================
 * DOMAIN PERSISTENCE
 * ==========================================================================
 *
 * Writes the four domains sync.js already fetches from Plaid — Identity,
 * Auth, Liabilities, Investments — into durable storage instead of letting
 * them be discarded after the sync HTTP response.
 *
 * PRINCIPLES (same as sync.js):
 *
 * 1. No observation is fabricated. Every write traces to a real Plaid
 *    response for a real, locally-mapped account.
 * 2. A Plaid account_id that doesn't resolve to a local account is skipped
 *    and reported, never silently dropped or guessed at.
 * 3. Sensitive numbers (account/routing) are encrypted before they touch
 *    the database. No plaintext financial identifier is ever written.
 * 4. These writes run AFTER the canonical transaction commit, using the
 *    same pooled client. A failure here must never be able to roll back
 *    or block canonical transaction data — callers are expected to wrap
 *    each call in its own try/catch (observeDomain already does this).
 */

async function getAccountMapForItem(
  client,
  itemId
) {
  const result =
    await client.query(
      `
        SELECT id, plaid_account_id
        FROM accounts
        WHERE plaid_item_id = $1
      `,
      [itemId]
    );

  const map = {};

  for (const row of result.rows) {
    map[row.plaid_account_id] = row.id;
  }

  return map;
}

/*
 * ==========================================================================
 * IDENTITY
 * ==========================================================================
 */

async function persistIdentity(
  client,
  itemId,
  data
) {
  const accountMap =
    await getAccountMapForItem(client, itemId);

  const accounts =
    Array.isArray(data?.accounts)
      ? data.accounts
      : [];

  let persisted = 0;
  const unmatched = [];

  for (const acct of accounts) {
    const accountId =
      accountMap[acct.account_id];

    if (!accountId) {
      unmatched.push(acct.account_id);
      continue;
    }

    const owners =
      Array.isArray(acct.owners)
        ? acct.owners
        : [];

    for (
      let ownerIndex = 0;
      ownerIndex < owners.length;
      ownerIndex += 1
    ) {
      const owner = owners[ownerIndex];

      await client.query(
        `
          INSERT INTO account_identity_owners (
            account_id,
            owner_index,
            names,
            emails,
            phone_numbers,
            addresses,
            raw,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, now())
          ON CONFLICT (account_id, owner_index)
          DO UPDATE SET
            names = EXCLUDED.names,
            emails = EXCLUDED.emails,
            phone_numbers = EXCLUDED.phone_numbers,
            addresses = EXCLUDED.addresses,
            raw = EXCLUDED.raw,
            updated_at = now()
        `,
        [
          accountId,
          ownerIndex,
          JSON.stringify(owner.names || []),
          JSON.stringify(owner.emails || []),
          JSON.stringify(owner.phone_numbers || []),
          JSON.stringify(owner.addresses || []),
          JSON.stringify(owner),
        ]
      );

      persisted += 1;
    }
  }

  return {
    state: 'observed',
    observations: persisted,
    unmatched_account_ids: unmatched,
  };
}

/*
 * ==========================================================================
 * AUTH (account / routing numbers)
 * ==========================================================================
 */

function lastFour(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  return value.slice(-4);
}

async function persistAuth(
  client,
  itemId,
  data
) {
  const accountMap =
    await getAccountMapForItem(client, itemId);

  const achNumbers =
    Array.isArray(data?.numbers?.ach)
      ? data.numbers.ach
      : [];

  let persisted = 0;
  const unmatched = [];

  for (const entry of achNumbers) {
    const accountId =
      accountMap[entry.account_id];

    if (!accountId) {
      unmatched.push(entry.account_id);
      continue;
    }

    await client.query(
      `
        INSERT INTO account_auth_numbers (
          account_id,
          numbers_type,
          account_number_encrypted,
          routing_number_encrypted,
          wire_routing_number_encrypted,
          account_number_mask,
          updated_at
        )
        VALUES ($1, 'ach', $2, $3, $4, $5, now())
        ON CONFLICT (account_id)
        DO UPDATE SET
          account_number_encrypted = EXCLUDED.account_number_encrypted,
          routing_number_encrypted = EXCLUDED.routing_number_encrypted,
          wire_routing_number_encrypted = EXCLUDED.wire_routing_number_encrypted,
          account_number_mask = EXCLUDED.account_number_mask,
          updated_at = now()
      `,
      [
        accountId,

        entry.account
          ? encrypt(String(entry.account))
          : null,

        entry.routing
          ? encrypt(String(entry.routing))
          : null,

        entry.wire_routing
          ? encrypt(String(entry.wire_routing))
          : null,

        lastFour(entry.account),
      ]
    );

    persisted += 1;
  }

  return {
    state: 'observed',
    observations: persisted,
    unmatched_account_ids: unmatched,
  };
}

/*
 * ==========================================================================
 * LIABILITIES
 * ==========================================================================
 */

function normalizeLiabilityRow(type, entry) {
  switch (type) {
    case 'credit':
      return {
        is_overdue: entry.is_overdue ?? null,
        last_payment_amount: entry.last_payment_amount ?? null,
        last_payment_date: entry.last_payment_date ?? null,
        next_payment_due_date:
          entry.next_payment_due_date ?? null,
        minimum_payment_amount:
          entry.minimum_payment_amount ?? null,
        last_statement_balance:
          entry.last_statement_balance ?? null,
        interest_rate_percentage:
          entry.aprs?.[0]?.apr_percentage ?? null,
      };

    case 'mortgage':
      return {
        is_overdue:
          entry.past_due_amount != null
            ? Number(entry.past_due_amount) > 0
            : null,
        last_payment_amount:
          entry.last_payment_amount ?? null,
        last_payment_date:
          entry.last_payment_date ?? null,
        next_payment_due_date:
          entry.next_payment_due_date ?? null,
        minimum_payment_amount:
          entry.next_monthly_payment ?? null,
        last_statement_balance: null,
        interest_rate_percentage:
          entry.interest_rate?.percentage ?? null,
      };

    case 'student':
      return {
        is_overdue: entry.is_overdue ?? null,
        last_payment_amount:
          entry.last_payment_amount ?? null,
        last_payment_date:
          entry.last_payment_date ?? null,
        next_payment_due_date:
          entry.next_payment_due_date ?? null,
        minimum_payment_amount:
          entry.minimum_payment_amount ?? null,
        last_statement_balance:
          entry.last_statement_balance ?? null,
        interest_rate_percentage:
          entry.interest_rate_percentage ?? null,
      };

    default:
      return {
        is_overdue: null,
        last_payment_amount: null,
        last_payment_date: null,
        next_payment_due_date: null,
        minimum_payment_amount: null,
        last_statement_balance: null,
        interest_rate_percentage: null,
      };
  }
}

async function persistLiabilities(
  client,
  itemId,
  data
) {
  const accountMap =
    await getAccountMapForItem(client, itemId);

  const liabilityGroups = [
    ['credit', data?.liabilities?.credit],
    ['mortgage', data?.liabilities?.mortgage],
    ['student', data?.liabilities?.student],
  ];

  let persisted = 0;
  const unmatched = [];

  for (const [type, entries] of liabilityGroups) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const accountId =
        accountMap[entry.account_id];

      if (!accountId) {
        unmatched.push(entry.account_id);
        continue;
      }

      const normalized =
        normalizeLiabilityRow(type, entry);

      await client.query(
        `
          INSERT INTO account_liabilities (
            account_id,
            liability_type,
            is_overdue,
            last_payment_amount,
            last_payment_date,
            next_payment_due_date,
            minimum_payment_amount,
            last_statement_balance,
            interest_rate_percentage,
            raw,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()
          )
          ON CONFLICT (account_id)
          DO UPDATE SET
            liability_type = EXCLUDED.liability_type,
            is_overdue = EXCLUDED.is_overdue,
            last_payment_amount = EXCLUDED.last_payment_amount,
            last_payment_date = EXCLUDED.last_payment_date,
            next_payment_due_date = EXCLUDED.next_payment_due_date,
            minimum_payment_amount = EXCLUDED.minimum_payment_amount,
            last_statement_balance = EXCLUDED.last_statement_balance,
            interest_rate_percentage = EXCLUDED.interest_rate_percentage,
            raw = EXCLUDED.raw,
            updated_at = now()
        `,
        [
          accountId,
          type,
          normalized.is_overdue,
          normalized.last_payment_amount,
          normalized.last_payment_date,
          normalized.next_payment_due_date,
          normalized.minimum_payment_amount,
          normalized.last_statement_balance,
          normalized.interest_rate_percentage,
          JSON.stringify(entry),
        ]
      );

      persisted += 1;
    }
  }

  return {
    state: 'observed',
    observations: persisted,
    unmatched_account_ids: unmatched,
  };
}

/*
 * ==========================================================================
 * INVESTMENTS
 * ==========================================================================
 */

async function persistInvestments(
  client,
  itemId,
  data
) {
  const accountMap =
    await getAccountMapForItem(client, itemId);

  const securities =
    Array.isArray(data?.securities)
      ? data.securities
      : [];

  const holdings =
    Array.isArray(data?.holdings)
      ? data.holdings
      : [];

  const securityIdMap = {};

  for (const security of securities) {
    const result =
      await client.query(
        `
          INSERT INTO investment_securities (
            plaid_security_id,
            ticker_symbol,
            name,
            security_type,
            close_price,
            close_price_as_of,
            iso_currency_code,
            raw,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
          ON CONFLICT (plaid_security_id)
          DO UPDATE SET
            ticker_symbol = EXCLUDED.ticker_symbol,
            name = EXCLUDED.name,
            security_type = EXCLUDED.security_type,
            close_price = EXCLUDED.close_price,
            close_price_as_of = EXCLUDED.close_price_as_of,
            iso_currency_code = EXCLUDED.iso_currency_code,
            raw = EXCLUDED.raw,
            updated_at = now()
          RETURNING id, plaid_security_id
        `,
        [
          security.security_id,
          security.ticker_symbol || null,
          security.name || null,
          security.type || null,
          security.close_price ?? null,
          security.close_price_as_of || null,
          security.iso_currency_code || 'USD',
          JSON.stringify(security),
        ]
      );

    securityIdMap[security.security_id] =
      result.rows[0].id;
  }

  let persisted = 0;
  const unmatchedAccounts = [];
  const unmatchedSecurities = [];

  for (const holding of holdings) {
    const accountId =
      accountMap[holding.account_id];

    if (!accountId) {
      unmatchedAccounts.push(holding.account_id);
      continue;
    }

    const securityId =
      securityIdMap[holding.security_id];

    if (!securityId) {
      unmatchedSecurities.push(holding.security_id);
      continue;
    }

    await client.query(
      `
        INSERT INTO investment_holdings (
          account_id,
          security_id,
          plaid_security_id,
          quantity,
          institution_price,
          institution_price_as_of,
          institution_value,
          cost_basis,
          iso_currency_code,
          raw,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()
        )
        ON CONFLICT (account_id, plaid_security_id)
        DO UPDATE SET
          security_id = EXCLUDED.security_id,
          quantity = EXCLUDED.quantity,
          institution_price = EXCLUDED.institution_price,
          institution_price_as_of = EXCLUDED.institution_price_as_of,
          institution_value = EXCLUDED.institution_value,
          cost_basis = EXCLUDED.cost_basis,
          iso_currency_code = EXCLUDED.iso_currency_code,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [
        accountId,
        securityId,
        holding.security_id,
        holding.quantity ?? null,
        holding.institution_price ?? null,
        holding.institution_price_as_of || null,
        holding.institution_value ?? null,
        holding.cost_basis ?? null,
        holding.iso_currency_code || 'USD',
        JSON.stringify(holding),
      ]
    );

    persisted += 1;
  }

  return {
    state: 'observed',
    observations: persisted,
    unmatched_account_ids: unmatchedAccounts,
    unmatched_security_ids: unmatchedSecurities,
  };
}

module.exports = {
  persistIdentity,
  persistAuth,
  persistLiabilities,
  persistInvestments,
};
