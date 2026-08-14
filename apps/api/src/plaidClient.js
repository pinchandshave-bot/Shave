require("dotenv").config();

const {
Configuration,
PlaidApi,
PlaidEnvironments,
} = require("plaid");

/*

* iBag Plaid Client
*
* Phase 1:
* * Real authorized financial data only.
* * Read-only intelligence.
* * No money movement.
* * No synthetic/mock/seeded financial data.
*
* iBag's eight Plaid intelligence domains:
*
* 1. Auth
* 2. Transactions
* 3. Identity
* 4. Assets
* 5. Liabilities
* 6. Investments
* 7. Statements
* 8. Income
*
* iBag domains that are NOT counted as one of the eight:
*
* Balance
* ```
  - Plaid capability automatically available through an Item.
  ```
* ```
  - Retrieved with accountsBalanceGet().
  ```
*
* Round-Ups
* ```
  - iBag intelligence derived from transaction data.
  ```
* ```
  - NOT a Plaid product.
  ```
* ```
  - Does NOT move money.
  ```
*
* IMPORTANT:
*
* Plaid product availability is evidence-gated.
*
* A product appearing in this file means iBag knows how to
* request/use that Plaid capability. It does NOT mean that
* the user's institution actually returned data for it.
*
* The application must distinguish:
*
* requested
* initialized
* available
* consented
* successfully queried
* records returned
* records persisted
* intelligence generated
*
* No empty table is treated as proof that a product worked.
  */

/* -------------------------------------------------------------------------- */
/* ENVIRONMENT                                                                */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* PLAID CLIENT                                                               */
/* -------------------------------------------------------------------------- */

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
/* IBAG PRODUCT DEFINITIONS                                                   */
/* -------------------------------------------------------------------------- */

/*

* Transactions is the required foundational product.
*
* It supports:
* * spending intelligence
* * cash-flow intelligence
* * merchant intelligence
* * behavioral intelligence
* * transaction intelligence
* * Round-Up intelligence
    */
    const PLAID_REQUIRED_PRODUCTS = [
    "transactions",
    ];

/*

* Ordinary optional Link products.
*
* These are deliberately separate from specialized workflows.
*
* Auth
* Identity
* Investments
* Liabilities
*
* are queried through their corresponding APIs after Link.
  */
  const PLAID_OPTIONAL_PRODUCTS = [
  "auth",
  "identity",
  "investments",
  "liabilities",
  ];

/*

* Specialized product workflows.
*
* These are NOT falsely represented as ordinary account-sync
* endpoints.
*
* Statements requires the appropriate Link configuration and
* statements workflow.
*
* Income uses Plaid's income-specific product/workflow.
*
* Assets uses Asset Reports.
  */
  const PLAID_SPECIALIZED_PRODUCTS = [
  "assets",
  "statements",
  "income_verification",
  ];

/*

* Balance is intentionally outside the eight-product count.
*
* It is a Plaid capability retrieved independently with:
*
* accountsBalanceGet()
  */
  const PLAID_AUTOMATIC_CAPABILITIES = [
  "balance",
  ];

/*

* Round-Ups are entirely an iBag intelligence domain.
*
* They are calculated from authorized transaction data.
*
* They are NOT:
*
* * a Plaid product
* * a Link product
* * a money movement capability
    */
    const IBAG_NON_PLAID_INTELLIGENCE = [
    "roundups",
    ];

/*

* Canonical iBag registry.
*
* This registry is an internal architecture map.
*
* It is NOT a direct copy of Plaid's Link products array.
  */
  const IBAG_PLAID_PRODUCTS = Object.freeze({
  auth: {
  plaidProduct: "auth",
  category: "plaid",
  linkMode: "optional",
  endpoint: "authGet",
  intelligenceDomain: "account_access",
  },

transactions: {
plaidProduct: "transactions",
category: "plaid",
linkMode: "required",
endpoint: "transactionsSync",
intelligenceDomain: "transactions",
},

identity: {
plaidProduct: "identity",
category: "plaid",
linkMode: "optional",
endpoint: "identityGet",
intelligenceDomain: "identity",
},

assets: {
plaidProduct: "assets",
category: "plaid",
linkMode: "specialized",
endpoint: "assetReport",
intelligenceDomain: "assets",
},

liabilities: {
plaidProduct: "liabilities",
category: "plaid",
linkMode: "optional",
endpoint: "liabilitiesGet",
intelligenceDomain: "liabilities",
},

investments: {
plaidProduct: "investments",
category: "plaid",
linkMode: "optional",
endpoint: "investmentsHoldingsGet",
intelligenceDomain: "investments",
},

statements: {
plaidProduct: "statements",
category: "plaid",
linkMode: "specialized",
endpoint: "statementsList",
intelligenceDomain: "statements",
},

income: {
plaidProduct: "income_verification",
category: "plaid",
linkMode: "specialized",
endpoint: "income",
intelligenceDomain: "income",
},

balance: {
plaidProduct: null,
category: "automatic",
linkMode: "automatic",
endpoint: "accountsBalanceGet",
intelligenceDomain: "liquidity",
countedInEight: false,
},

roundups: {
plaidProduct: null,
category: "ibag",
linkMode: "internal",
endpoint: null,
intelligenceDomain: "roundups",
countedInEight: false,
},
});

/*

* Explicit count of the eight Plaid intelligence products.
*
* This prevents Balance and Round-Ups from accidentally being
* counted as products.
  */
  const IBAG_EIGHT_PLAID_PRODUCTS = Object.freeze([
  "auth",
  "transactions",
  "identity",
  "assets",
  "liabilities",
  "investments",
  "statements",
  "income",
  ]);

/* -------------------------------------------------------------------------- */
/* LINK TOKEN                                                                 */
/* -------------------------------------------------------------------------- */

/**

* Create the initial Link token.
*
* Transactions is required.
*
* Auth, Identity, Investments and Liabilities are optional.
*
* Specialized products are represented separately because their
* workflows have additional requirements.
*
* Balance is automatic and is not placed into products.
  */
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

```
client_name: "iBag",

country_codes: ["US"],

language: "en",

products: PLAID_REQUIRED_PRODUCTS,

optional_products: PLAID_OPTIONAL_PRODUCTS,
```

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

  required_products: PLAID_REQUIRED_PRODUCTS,

  optional_products: PLAID_OPTIONAL_PRODUCTS,

  specialized_products:
    PLAID_SPECIALIZED_PRODUCTS,

  automatic_capabilities:
    PLAID_AUTOMATIC_CAPABILITIES,

  ibag_non_plaid_intelligence:
    IBAG_NON_PLAID_INTELLIGENCE,

  eight_product_domains:
    IBAG_EIGHT_PLAID_PRODUCTS,
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
/* UPDATE-MODE LINK TOKEN                                                     */
/* -------------------------------------------------------------------------- */

/**

* Create an Update Mode Link token for an existing Item.
*
* Specialized Plaid workflows may require an existing Item to
* be updated rather than assuming every capability was initialized
* during the original Link session.
  */
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

```
client_name: "iBag",

access_token: accessToken,

country_codes: ["US"],

language: "en",
```

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
/* ITEM / PRODUCT DISCOVERY                                                   */
/* -------------------------------------------------------------------------- */

/**

* Retrieve authoritative Plaid Item state.
*
* iBag uses this to distinguish what was requested from what
* Plaid actually initialized or made available.
  */
  async function getItem(accessToken) {
  if (!accessToken) {
  throw new Error("getItem requires accessToken");
  }

try {
const response =
await plaidClient.itemGet({
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

/**

* Build explicit product evidence from the Plaid Item.
*
* This function does not claim that an endpoint produced data.
* It only reports Plaid's Item-level product state.
  */
  async function getProductCoverage(accessToken) {
  const itemData = await getItem(accessToken);

const item = itemData.item || itemData;

const products = Array.isArray(item.products)
? item.products
: [];

const billedProducts = Array.isArray(
item.billed_products
)
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

const requestedProducts = [
...PLAID_REQUIRED_PRODUCTS,
...PLAID_OPTIONAL_PRODUCTS,
...PLAID_SPECIALIZED_PRODUCTS,
];

return {
requested: requestedProducts,

```
initialized: products,

billed: billedProducts,

available: availableProducts,

consented: consentedProducts,

eight_product_domains:
  IBAG_EIGHT_PLAID_PRODUCTS,

balance: {
  available: true,

  automatic: true,

  counted_in_eight: false,

  endpoint: "accountsBalanceGet",
},

roundups: {
  plaid_product: false,

  iBag_intelligence: true,

  counted_in_eight: false,

  source_domain: "transactions",
},
```

};
}

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

/**

* Retrieve Auth data.
  */
  async function getAuth(accessToken) {
  if (!accessToken) {
  throw new Error("getAuth requires accessToken");
  }

try {
const response =
await plaidClient.authGet({
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

/**

* Retrieve current balances.
*
* Balance is a first-class iBag intelligence domain but is
* explicitly excluded from the eight Plaid-product count.
  */
  async function getBalances(accessToken) {
  if (!accessToken) {
  throw new Error(
  "getBalances requires accessToken"
  );
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

/**

* Synchronize Transactions using Plaid's cursor-based API.
  */
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

/**

* Retrieve Identity data.
  */
  async function getIdentity(accessToken) {
  if (!accessToken) {
  throw new Error(
  "getIdentity requires accessToken"
  );
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

/**

* Retrieve liability data.
  */
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

/**

* Retrieve investment holdings and securities.
  */
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
/* ASSETS                                                                     */
/* -------------------------------------------------------------------------- */

/**

* Create an Asset Report.
*
* Asset Reports use a specialized Plaid workflow.
  */
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

```
days_requested: daysRequested,
```

};

if (
options &&
typeof options === "object" &&
Object.keys(options).length > 0
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

/**

* Retrieve an Asset Report.
  */
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

/**

* Retrieve available statements.
  */
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
/* INCOME                                                                     */
/* -------------------------------------------------------------------------- */

/**

* Income is intentionally represented as a specialized product
* domain rather than pretending it is the same API shape as
* Transactions, Identity, or Liabilities.
*
* The exact Income workflow used by iBag must be selected based
* on the Income capability configured in the application's
* Plaid environment.
*
* This wrapper exposes the SDK's income-related operation when
* available without silently fabricating an endpoint.
  */
  async function getIncome(accessToken, options = {}) {
  if (!accessToken) {
  throw new Error(
  "getIncome requires accessToken"
  );
  }

/*

* Plaid's Income capabilities have specialized workflows.
*
* Do not silently substitute transaction-derived income for
* Plaid Income product evidence.
*
* If the installed Plaid SDK exposes a direct income endpoint,
* use it. Otherwise return an explicit unsupported-operation
* error so the caller cannot mistake absence for success.
  */

const incomeMethod =
plaidClient.incomeGet ||
plaidClient.incomeVerificationGet;

if (typeof incomeMethod !== "function") {
const error = new Error(
"Installed Plaid SDK does not expose a direct Income retrieval method"
);

```
error.code = "PLAID_INCOME_ENDPOINT_UNAVAILABLE";

throw error;
```

}

try {
const request = {
access_token: accessToken,
...options,
};

```
const response =
  await incomeMethod.call(
    plaidClient,
    request
  );

return response.data;
```

} catch (error) {
throw normalizePlaidError(
error,
"PLAID_INCOME_GET_FAILED"
);
}
}

/* -------------------------------------------------------------------------- */
/* PRODUCT DEFINITIONS / EVIDENCE HELPERS                                     */
/* -------------------------------------------------------------------------- */

/**

* Return the canonical eight-product definition.
*
* This is useful to API routes and intelligence services that
* need to prove which domains iBag is designed to utilize.
  */
  function getEightProductDefinition() {
  return {
  count: IBAG_EIGHT_PLAID_PRODUCTS.length,

  products: IBAG_EIGHT_PLAID_PRODUCTS.map(
  (key) => ({
  key,

  ```
   ...IBAG_PLAID_PRODUCTS[key],
  ```

  })
  ),

  excluded_from_count: {
  balance: {
  reason:
  "Automatic Plaid capability retrieved through accountsBalanceGet.",
  },

  roundups: {
  reason:
  "iBag transaction intelligence feature, not a Plaid product.",
  },
  },
  };
  }

/**

* Determine whether a Plaid product is actually initialized
* according to Item state.
*
* This is deliberately evidence-based.
  */
  function isProductInitialized(
  productKey,
  coverage
  ) {
  const definition =
  IBAG_PLAID_PRODUCTS[productKey];

if (!definition) {
return false;
}

if (
productKey === "balance" ||
productKey === "roundups"
) {
return false;
}

const plaidProduct =
definition.plaidProduct;

if (!plaidProduct) {
return false;
}

return Array.isArray(coverage?.initialized)
? coverage.initialized.includes(
plaidProduct
)
: false;
}

/* -------------------------------------------------------------------------- */
/* ERROR NORMALIZATION                                                        */
/* -------------------------------------------------------------------------- */

/**

* Convert Plaid SDK errors into a stable internal structure.
*
* Real Plaid errors remain errors.
*
* They are never converted into "no data."
  */
  function normalizePlaidError(
  error,
  fallbackCode
  ) {
  const responseData =
  error?.response?.data || {};

return Object.assign(
new Error(
responseData.error_message ||
error?.message ||
fallbackCode
),

```
{
  code:
    responseData.error_code ||
    fallbackCode,

  type:
    responseData.error_type ||
    null,

  status:
    responseData.error_code ||
    fallbackCode,

  requestId:
    responseData.request_id ||
    error?.response?.headers?.[
      "plaid-request-id"
    ] ||
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
PLAID_AUTOMATIC_CAPABILITIES,
IBAG_NON_PLAID_INTELLIGENCE,

IBAG_PLAID_PRODUCTS,
IBAG_EIGHT_PLAID_PRODUCTS,

createLinkToken,
createUpdateModeLinkToken,

getItem,
getProductCoverage,
getEightProductDefinition,
isProductInitialized,

getAuth,
getBalances,
syncTransactions,
getIdentity,
getLiabilities,
getInvestments,

createAssetReport,
getAssetReport,

getStatements,
getIncome,

normalizePlaidError,
};
