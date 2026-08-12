const pool = require("./db");
const { requireAuth } = require("./auth");

async function getMe(req, res) {
  try {
    const userResult = await pool.query(
      `
        SELECT
          id,
          email,
          created_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    const user = userResult.rows[0];

    const ibagResult = await pool.query(
      `
        SELECT
          id,
          user_id,
          created_at
        FROM ibags
        WHERE user_id = $1
        LIMIT 1
      `,
      [user.id]
    );

    const accountsResult = await pool.query(
      `
        SELECT
          a.id,
          a.plaid_account_id,
          a.name,
          a.official_name,
          a.mask,
          a.type,
          a.subtype
        FROM accounts a
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
        ORDER BY a.created_at ASC
      `,
      [user.id]
    );

    return res.json({
      status: "ok",
      user,
      ibag: ibagResult.rows[0] || null,
      accounts: accountsResult.rows,
    });
  } catch (err) {
    console.error("Get current user failed:", err);

    return res.status(500).json({
      status: "error",
      message: "Unable to load your iBag right now",
    });
  }
}

module.exports = {
  requireAuth,
  getMe,
};
