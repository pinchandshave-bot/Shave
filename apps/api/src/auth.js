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
