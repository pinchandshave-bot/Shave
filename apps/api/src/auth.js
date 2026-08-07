const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ status: 'error', message: 'Missing bearer token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

async function signup(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ status: 'error', message: 'Email and an 8+ character password are required' });
    }
    const existing = await pool.query('select id from users where email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ status: 'error', message: 'An account with that email already exists' });
    }
    const password_hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, created_at',
      [email, password_hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ status: 'ok', user, token });
  } catch (err) {
    console.error('signup error:', err.message);
    res.status(500).json({ status: 'error', message: 'Signup failed. Check server logs.' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    const result = await pool.query('select id, email, password_hash from users where email = $1', [email]);
    const dummyHash = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO/gI0vP7wKI.hHqB8H0jXvUKlF0k5T3W';
    const row = result.rows[0];
    const valid = await bcrypt.compare(password || '', row ? row.password_hash : dummyHash);
    if (!row || !valid) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: row.id, email: row.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ status: 'ok', user: { id: row.id, email: row.email }, token });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ status: 'error', message: 'Login failed. Check server logs.' });
  }
}

module.exports = { requireAuth, signup, login };
