const pool = require('./db');
const plaidClient = require('./plaidClient').plaidClient;

async function syncBalance(accessToken, acctMap) {
  const response = await plaidClient.accountsBalanceGet({ access_token: accessToken });
  for (const acct of response.data.accounts) {
    const accountId = acctMap[acct.account_id];
    if (!accountId) continue;
    await pool.query(
      `update accounts set
         current_balance = $1, available_balance = $2,
         balance_iso_currency_code = $3, balance_updated_at = now()
       where id = $4`,
      [
        acct.balances.current,
        acct.balances.available,
        acct.balances.iso_currency_code || 'USD',
        accountId,
      ]
    );
  }
}

async function syncLiabilities(accessToken, acctMap) {
  let data;
  try {
    const response = await plaidClient.liabilitiesGet({ access_token: accessToken });
    data = response.data.liabilities;
  } catch (err) {
    // Not every linked account type returns liabilities data — Plaid errors
    // on that rather than returning empty. Treat as "nothing to sync."
    return;
  }
  if (!data) return;

  for (const credit of data.credit || []) {
    const accountId = acctMap[credit.account_id];
    if (!accountId) continue;
    await pool.query(
      `insert into liabilities_credit
        (account_id, aprs, is_overdue, last_payment_amount, last_payment_date,
         last_statement_balance, last_statement_issue_date, minimum_payment_amount,
         next_payment_due_date, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (account_id) do update set
         aprs = excluded.aprs, is_overdue = excluded.is_overdue,
         last_payment_amount = excluded.last_payment_amount, last_payment_date = excluded.last_payment_date,
         last_statement_balance = excluded.last_statement_balance,
         last_statement_issue_date = excluded.last_statement_issue_date,
         minimum_payment_amount = excluded.minimum_payment_amount,
         next_payment_due_date = excluded.next_payment_due_date, updated_at = now()`,
      [
        accountId, JSON.stringify(credit.aprs || []), credit.is_overdue,
        credit.last_payment_amount, credit.last_payment_date,
        credit.last_statement_balance, credit.last_statement_issue_date,
        credit.minimum_payment_amount, credit.next_payment_due_date,
      ]
    );
  }

  for (const student of data.student || []) {
    const accountId = acctMap[student.account_id];
    if (!accountId) continue;
    await pool.query(
      `insert into liabilities_student
        (account_id, loan_name, is_overdue, guarantor, interest_rate_percentage,
         minimum_payment_amount, next_payment_due_date, expected_payoff_date,
         last_statement_issue_date, origination_principal_amount,
         outstanding_interest_amount, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       on conflict (account_id) do update set
         loan_name = excluded.loan_name, is_overdue = excluded.is_overdue,
         guarantor = excluded.guarantor,
         interest_rate_percentage = excluded.interest_rate_percentage,
         minimum_payment_amount = excluded.minimum_payment_amount,
         next_payment_due_date = excluded.next_payment_due_date,
         expected_payoff_date = excluded.expected_payoff_date,
         last_statement_issue_date = excluded.last_statement_issue_date,
         origination_principal_amount = excluded.origination_principal_amount,
         outstanding_interest_amount = excluded.outstanding_interest_amount, updated_at = now()`,
      [
        accountId, student.loan_name, student.is_overdue, student.guarantor,
        student.interest_rate_percentage, student.minimum_payment_amount,
        student.next_payment_due_date, student.expected_payoff_date,
        student.last_statement_issue_date, student.origination_principal_amount,
        student.outstanding_interest_amount,
      ]
    );
  }

  for (const mortgage of data.mortgage || []) {
    const accountId = acctMap[mortgage.account_id];
    if (!accountId) continue;
    await pool.query(
      `insert into liabilities_mortgage
        (account_id, loan_type_description, interest_rate_percentage, interest_rate_type,
         last_payment_amount, last_payment_date, next_payment_due_date, next_monthly_payment,
         origination_principal_amount, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (account_id) do update set
         loan_type_description = excluded.loan_type_description,
         interest_rate_percentage = excluded.interest_rate_percentage,
         interest_rate_type = excluded.interest_rate_type,
         last_payment_amount = excluded.last_payment_amount, last_payment_date = excluded.last_payment_date,
         next_payment_due_date = excluded.next_payment_due_date, next_monthly_payment = excluded.next_monthly_payment,
         origination_principal_amount = excluded.origination_principal_amount, updated_at = now()`,
      [
        accountId, mortgage.loan_type_description,
        mortgage.interest_rate?.percentage, mortgage.interest_rate?.type,
        mortgage.last_payment_amount, mortgage.last_payment_date,
        mortgage.next_payment_due_date, mortgage.next_monthly_payment,
        mortgage.origination_principal_amount,
      ]
    );
  }
}

async function syncInvestments(accessToken, acctMap) {
  let data;
  try {
    const response = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
    data = response.data;
  } catch (err) {
    return; // Item has no investment accounts — expected, not an error.
  }
  const securitiesById = {};
  for (const sec of data.securities || []) securitiesById[sec.security_id] = sec;

  for (const holding of data.holdings || []) {
    const accountId = acctMap[holding.account_id];
    if (!accountId) continue;
    const security = securitiesById[holding.security_id] || {};
    await pool.query(
      `insert into investment_holdings
        (account_id, security_id, security_name, ticker_symbol, security_type,
         quantity, institution_price, institution_value, cost_basis, iso_currency_code, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (account_id, security_id) do update set
         security_name = excluded.security_name, ticker_symbol = excluded.ticker_symbol,
         security_type = excluded.security_type, quantity = excluded.quantity,
         institution_price = excluded.institution_price, institution_value = excluded.institution_value,
         cost_basis = excluded.cost_basis, iso_currency_code = excluded.iso_currency_code, updated_at = now()`,
      [
        accountId, holding.security_id, security.name || null, security.ticker_symbol || null,
        security.type || null, holding.quantity, holding.institution_price,
        holding.institution_value, holding.cost_basis, holding.iso_currency_code || 'USD',
      ]
    );
  }
}

async function syncIdentity(accessToken, plaidItemDbId, acctMap) {
  let data;
  try {
    const response = await plaidClient.identityGet({ access_token: accessToken });
    data = response.data.accounts;
  } catch (err) {
    return;
  }
  for (const acct of data || []) {
    const accountId = acctMap[acct.account_id];
    if (!accountId) continue;
    const owner = (acct.owners && acct.owners[0]) || {};
    await pool.query(
      `insert into identity_data (plaid_item_id, account_id, names, emails, phone_numbers, addresses, updated_at)
       values ($1,$2,$3,$4,$5,$6, now())
       on conflict (account_id) do update set
         names = excluded.names, emails = excluded.emails,
         phone_numbers = excluded.phone_numbers, addresses = excluded.addresses, updated_at = now()`,
      [
