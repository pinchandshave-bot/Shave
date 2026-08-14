require("dotenv").config();

const {
Configuration,
PlaidApi,
PlaidEnvironments,
} = require("plaid");

/*

* iBag Plaid Client
*
* Production integration boundary for Plaid.
*
* Rules:
* * Real authorized financial data only.
* * Read-only intelligence.
* * No money movement.
* * No synthetic, mock, seeded, or fabricated financial data.
* * Plaid product availability is never inferred from requested products.
    */

const plaidEnv =
process.env.PLAID_ENV === "production"
? PlaidEnvironments.production
: PlaidEnvironments.sandbox;

const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env.PLAID_SECRET;

if (!clientId) {
throw new Error("Missing PLAID_CLIENT_ID");
}

if (!secret) {
throw new Error("Missing PLAID_SECRET");
}

const configuration = new Configuration({
basePath: plaidEnv,
baseOptions: {
headers: {
"PLAID-CLIENT-ID": clientId,
"PLAID-SECRET": secret,
},
},
});

const plaidClient = new PlaidApi(configuration);

/* -------------------------------------------------------------------------- */
/* PLAID PRODUCT CONFIGURATION                                               */
/* -------------------------------------------------------------------------- */

const PLAID_REQUIRED_PRODUCTS = [
"transactions",
];

const PLAID_OPTIONAL_PRODUCTS = [
"auth",
"identity",
"investments",
"liabilities",
"statements",
];

const PLAID_SPECIALIZED_PRODUCTS = [
"assets",
];

const IBAG_PLAID_PRODUCTS = Object.freeze({
auth: {
plaidProduct: "auth",
linkMode: "optional",
endpoint: "authGet",
intelligenceDomain: "account_access",
},

transactions: {
plaidProduct: "transactions",
linkMode: "required",
endpoint: "transactionsSync",
intelligenceDomain: "transactions",
},

balance: {
plaidProduct: null,
linkMode: "automatic",
endpoint: "accountsBalanceGet",
intelligenceDomain: "liquidity",
},

identity: {
plaidProduct: "identity",
linkMode: "optional",
endpoint: "identityGet",
intelligenceDomain: "identity",
},

assets: {
plaidProduct: "assets",
linkMode: "specialized",
endpoint: "assetReport",
intelligenceDomain: "assets",
},

liabilities: {
plaidProduct: "liabilities",
linkMode: "optional",
endpoint: "liabilitiesGet",
intelligenceDomain: "liabilities",
},

investments: {
plaidProduct: "investments",
linkMode: "optional",
endpoint: "investmentsHoldingsGet",
intelligenceDomain: "investments",
},

statements: {
plaidProduct: "statements",
linkMode: "optional",
endpoint: "statementsList",
intelligenceDomain: "statements",
},
});

/* -------------------------------------------------------------------------- */
/* LINK TOKEN                                                                 */
/* -------------------------------------------------------------------------- */

async function createLinkToken({
userId,
webhookUrl = null,
} = {}) {
if (!userId) {
throw new Error("createLinkToken requires userId");
}

const request = {
user: {
client_user_id: String(userId),
},
client_name: "iBag",
country_codes: ["US"],
language: "en",
products: PLAID_REQUIRED_PRODUCTS,
optional_products: PLAID_OPTIONAL_PRODUCTS,
};

if (webhookUrl) {
request.webhook = webhookUrl;
}

try {
const response = await plaidClient.linkTokenCreate(request);

```
return {
  link_token: response.data.link_token,
  expiration: response.data.expiration,
  request_id: response.data.request_id,
  initial_products: PLAID_REQUIRED_PRODUCTS,
  optional_products: PLAID_OPTIONAL_PRODUCTS,
  balance: {
    available: true,
    initialization: "automatic",
  },
  specialized_products: PLAID_SPECIALIZED_PRODUCTS,
};
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_LINK_TOKEN_CREATE_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* UPDATE MODE LINK TOKEN                                                     */
/* -------------------------------------------------------------------------- */

async function createUpdateModeLinkToken({
userId,
accessToken,
webhookUrl = null,
} = {}) {
if (!userId) {
throw new Error(
"createUpdateModeLinkToken requires userId"
);
}

if (!accessToken) {
throw new Error(
"createUpdateModeLinkToken requires accessToken"
);
}

const request = {
user: {
client_user_id: String(userId),
},
client_name: "iBag",
access_token: accessToken,
country_codes: ["US"],
language: "en",
};

if (webhookUrl) {
request.webhook = webhookUrl;
}

try {
const response =
await plaidClient.linkTokenCreate(request);

```
return {
  link_token: response.data.link_token,
  expiration: response.data.expiration,
  request_id: response.data.request_id,
};
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* ITEM                                                                       */
/* -------------------------------------------------------------------------- */

async function getItem(accessToken) {
if (!accessToken) {
throw new Error("getItem requires accessToken");
}

try {
const response = await plaidClient.itemGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_ITEM_GET_FAILED"
);
}
}

async function getProductCoverage(accessToken) {
const itemData = await getItem(accessToken);

const item = itemData.item || itemData;

const products = Array.isArray(item.products)
? item.products
: [];

const billedProducts = Array.isArray(item.billed_products)
? item.billed_products
: [];

const availableProducts = Array.isArray(
item.available_products
)
? item.available_products
: [];

const consentedProducts = Array.isArray(
item.consented_products
)
? item.consented_products
: [];

return {
requested: [
...PLAID_REQUIRED_PRODUCTS,
...PLAID_OPTIONAL_PRODUCTS,
],
initialized: products,
billed: billedProducts,
available: availableProducts,
consented: consentedProducts,
balance: {
available: true,
reason:
"Balance is retrieved through accountsBalanceGet.",
},
specialized: PLAID_SPECIALIZED_PRODUCTS,
};
}

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

async function getAuth(accessToken) {
if (!accessToken) {
throw new Error("getAuth requires accessToken");
}

try {
const response = await plaidClient.authGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_AUTH_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* BALANCE                                                                    */
/* -------------------------------------------------------------------------- */

async function getBalances(accessToken) {
if (!accessToken) {
throw new Error("getBalances requires accessToken");
}

try {
const response =
await plaidClient.accountsBalanceGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_BALANCE_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* TRANSACTIONS                                                               */
/* -------------------------------------------------------------------------- */

async function syncTransactions(
accessToken,
cursor = null
) {
if (!accessToken) {
throw new Error(
"syncTransactions requires accessToken"
);
}

const request = {
access_token: accessToken,
};

if (cursor) {
request.cursor = cursor;
}

try {
const response =
await plaidClient.transactionsSync(request);

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_TRANSACTIONS_SYNC_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* IDENTITY                                                                   */
/* -------------------------------------------------------------------------- */

async function getIdentity(accessToken) {
if (!accessToken) {
throw new Error("getIdentity requires accessToken");
}

try {
const response =
await plaidClient.identityGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_IDENTITY_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* LIABILITIES                                                                */
/* -------------------------------------------------------------------------- */

async function getLiabilities(accessToken) {
if (!accessToken) {
throw new Error(
"getLiabilities requires accessToken"
);
}

try {
const response =
await plaidClient.liabilitiesGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_LIABILITIES_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* INVESTMENTS                                                                */
/* -------------------------------------------------------------------------- */

async function getInvestments(accessToken) {
if (!accessToken) {
throw new Error(
"getInvestments requires accessToken"
);
}

try {
const response =
await plaidClient.investmentsHoldingsGet({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_INVESTMENTS_HOLDINGS_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* ASSET REPORT                                                               */
/* -------------------------------------------------------------------------- */

async function createAssetReport({
accessToken,
daysRequested = 90,
options = {},
} = {}) {
if (!accessToken) {
throw new Error(
"createAssetReport requires accessToken"
);
}

const request = {
access_tokens: [accessToken],
days_requested: daysRequested,
};

if (
options &&
typeof options === "object" &&
!Array.isArray(options)
) {
request.options = options;
}

try {
const response =
await plaidClient.assetReportCreate(request);

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_ASSET_REPORT_CREATE_FAILED"
);
}
}

async function getAssetReport(assetReportToken) {
if (!assetReportToken) {
throw new Error(
"getAssetReport requires assetReportToken"
);
}

try {
const response =
await plaidClient.assetReportGet({
asset_report_token: assetReportToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_ASSET_REPORT_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* STATEMENTS                                                                 */
/* -------------------------------------------------------------------------- */

async function getStatements(accessToken) {
if (!accessToken) {
throw new Error(
"getStatements requires accessToken"
);
}

try {
const response =
await plaidClient.statementsList({
access_token: accessToken,
});

```
return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_STATEMENTS_LIST_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* ERROR NORMALIZATION                                                        */
/* -------------------------------------------------------------------------- */

function normalizePlaidError(error, fallbackCode) {
const responseData =
error?.response?.data || {};

return Object.assign(
new Error(
responseData.error_message ||
error?.message ||
fallbackCode
),
{
code:
responseData.error_code ||
fallbackCode,

```
  type:
    responseData.error_type ||
    null,

  status:
    responseData.error_code ||
    fallbackCode,

  requestId:
    responseData.request_id ||
    error?.response?.headers?.["plaid-request-id"] ||
    null,

  displayMessage:
    responseData.display_message ||
    null,

  cause: error,
}
```

);
}

/* -------------------------------------------------------------------------- */
/* EXPORTS                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
plaidClient,

PLAID_REQUIRED_PRODUCTS,
PLAID_OPTIONAL_PRODUCTS,
PLAID_SPECIALIZED_PRODUCTS,

IBAG_PLAID_PRODUCTS,

createLinkToken,
createUpdateModeLinkToken,

getItem,
getProductCoverage,

getAuth,
getBalances,
syncTransactions,

getIdentity,
getLiabilities,
getInvestments,

createAssetReport,
getAssetReport,

getStatements,

normalizePlaidError,
};
