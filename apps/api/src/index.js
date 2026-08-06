require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shave-api', time: new Date().toISOString() });
});

app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query('select now() as db_time, count(*) as user_count from users');
    res.json({ status: 'ok', db_time: result.rows[0].db_time, user_count: result.rows[0].user_count });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`shave-api listening on port ${PORT}`);
});
