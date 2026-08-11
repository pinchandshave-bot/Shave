const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      status: 'error',
      message: 'Missing bearer token',
    });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid or expired token',
    });
  }
}

function requireInternalSecret(req, res, next) {
  const provided = req.headers['x-internal-secret'];

  if (!provided || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized',
    });
  }

  next();
}

async function signup(req, res) {
  const { email, password } = req.body;

  if (!email || !password || password.length < 8) {
    return res.status(400).json({
      status: 'error',
      message: 'Email and an 8+ character password are required',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'select id from users where email = $1',
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        status: 'error',
        message: 'An account with that email already exists',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userResult = await client.query(
      `insert into users
        (email, password_hash)
       values ($1, $2)
       returning id, email, created_at`,
      [normalizedEmail, passwordHash]
    );

    const user = userResult.rows[0];

    const ibagResult = await client.query(
      `insert into ibags
        (user_id)
       values ($1)
       returning id, user_id, created_at`,
      [user.id]
    );

    const ibag = ibagResult.rows[0];

    await client.query('COMMIT');

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    return res.status(201).json({
      status: 'ok',
      user,
      ibag,
      token,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Transaction may already have been rolled back.
    }

    console.error('Signup failed:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Unable to create your iBag right now',
    });
  } finally {
    client.release();
  }
}

async function login(req, res) {
  const { email, password } = req.body;

  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();

  const result = await pool.query(
    `select id, email, password_hash
     from users
     where email = $1`,
    [normalizedEmail]
  );

  const dummyHash =
    '$2b$12$C6UzMDM.H6dfI/f/IKcEeO/gI0vP7wKI.hHqB8H0jXvUKlF0k5T3W';

  const row = result.rows[0];

  const valid = await bcrypt.compare(
    password || '',
    row ? row.password_hash : dummyHash
  );

  if (!row || !valid) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid email or password',
    });
  }

  const token = jwt.sign(
    {
      id: row.id,
      email: row.email,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  );

  const ibagResult = await pool.query(
    `select id, user_id, created_at
     from ibags
     where user_id = $1`,
    [row.id]
  );

  return res.json({
    status: 'ok',
    user: {
      id: row.id,
      email: row.email,
    },
    ibag: ibagResult.rows[0] || null,
    token,
  });
}

module.exports = {
  requireAuth,
  requireInternalSecret,
  signup,
  login,
};
