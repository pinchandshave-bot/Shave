const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('./db');

// Startup check for critical security secrets
if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not defined.');
}

/**
 * Timing-safe string comparison to prevent timing side-channel attacks.
 */
function safeTimingCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * JWT Authentication Guard Middleware
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      status: 'error',
      message: 'Missing bearer token',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid or expired token',
    });
  }
}

/**
 * Timing-Safe Internal Microservice Secret Guard
 */
function requireInternalSecret(req, res, next) {
  const provided = req.headers['x-internal-secret'];
  const expected = process.env.INTERNAL_SECRET;

  if (!provided || !expected || !safeTimingCompare(provided, expected)) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access',
    });
  }

  next();
}

/**
 * User Registration Handler
 */
async function signup(req, res) {
  const { email, password } = req.body;

  if (!email || !password || password.length < 8) {
    return res.status(400).json({
      status: 'error',
      message: 'Email and an 8+ character password are required',
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
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
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [normalizedEmail, passwordHash]
    );

    const user = userResult.rows[0];

    const ibagResult = await client.query(
      `INSERT INTO ibags (user_id)
       VALUES ($1)
       RETURNING id, user_id, created_at`,
      [user.id]
    );

    const ibag = ibagResult.rows[0];

    // Log security audit event inside transaction
    await client.query(
      `INSERT INTO public.security_audit_logs (user_id, event_type, ip_address, user_agent)
       VALUES ($1, 'USER_SIGNUP_SUCCESS', $2, $3)`,
      [user.id, req.ip, req.headers['user-agent'] || null]
    );

    await client.query('COMMIT');

    // Generate standard Access Token (15m) & Refresh Token (7d)
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      status: 'ok',
      user,
      ibag,
      token,
      refreshToken,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Transaction already rolled back
    }

    console.error('[Auth Error] Signup transaction failed:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Unable to create your iBag right now',
    });
  } finally {
    client.release();
  }
}

/**
 * User Login Handler with Timing-Attack Defense
 */
async function login(req, res) {
  const { email, password } = req.body;

  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();

  try {
    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM users
       WHERE email = $1`,
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
      // Audit security log for failed login attempt
      if (row) {
        await pool.query(
          `INSERT INTO public.security_audit_logs (user_id, event_type, ip_address, user_agent)
           VALUES ($1, 'USER_LOGIN_FAILED', $2, $3)`,
          [row.id, req.ip, req.headers['user-agent'] || null]
        );
      }

      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password',
      });
    }

    const token = jwt.sign(
      { id: row.id, email: row.email },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { id: row.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const ibagResult = await pool.query(
      `SELECT id, user_id, created_at
       FROM ibags
       WHERE user_id = $1`,
      [row.id]
    );

    // Audit successful login
    await pool.query(
      `INSERT INTO public.security_audit_logs (user_id, event_type, ip_address, user_agent)
       VALUES ($1, 'USER_LOGIN_SUCCESS', $2, $3)`,
      [row.id, req.ip, req.headers['user-agent'] || null]
    );

    return res.json({
      status: 'ok',
      user: {
        id: row.id,
        email: row.email,
      },
      ibag: ibagResult.rows[0] || null,
      token,
      refreshToken,
    });
  } catch (err) {
    console.error('[Auth Error] Login processing failed:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to sign in right now',
    });
  }
}

module.exports = {
  requireAuth,
  requireInternalSecret,
  signup,
  login,
};
