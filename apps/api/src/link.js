const express = require("express");
const router = express.Router();

const { requireAuth } = require("./auth");
const plaidClient = require("./plaidClient");

const PLAID_CLIENT_NAME = "iBag";

function getWebhookUrl() {
  const webhookUrl = process.env.PLAID_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("PLAID_WEBHOOK_URL is not configured");
  }

  if (!/^https?:\/\/.+/.test(webhookUrl)) {
    throw new Error("PLAID_WEBHOOK_URL must be a valid HTTP or HTTPS URL");
  }

  return webhookUrl;
}

/**
 * POST /api/plaid/link/token
 *
 * Step 1 of the Plaid connection lifecycle:
 *
 * Authenticated iBag user
 *        ↓
 * /link/token/create
 *        ↓
 * short-lived Plaid link_token
 *
 * This endpoint does NOT:
 * - exchange a public_token
 * - create an Item
 * - store an access_token
 * - retrieve accounts
 * - retrieve transactions
 * - calculate Round-Ups
 * - move money
 */
router.post("/link/token", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "AUTHENTICATION_REQUIRED",
        message: "An authenticated iBag user is required.",
      });
    }

    const webhookUrl = getWebhookUrl();

    const request = {
      user: {
        client_user_id: String(userId),
      },

      client_name: PLAID_CLIENT_NAME,

      country_codes: ["US"],

      language: "en",

      products: ["transactions"],

      transactions: {
        days_requested: 730,
      },

      webhook: webhookUrl,
    };

    const response = await plaidClient.linkTokenCreate(request);

    const data = response?.data;

    if (!data?.link_token) {
      throw new Error("Plaid did not return a link_token");
    }

    return res.status(200).json({
      link_token: data.link_token,
      expiration: data.expiration,
    });
  } catch (error) {
    console.error("Plaid Link token creation failed:", error);

    return res.status(502).json({
      error: "PLAID_LINK_TOKEN_CREATION_FAILED",
      message: "Unable to create a Plaid Link session.",
    });
  }
});

module.exports = router;
