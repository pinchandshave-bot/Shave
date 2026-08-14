const express = require('express');

const app = express();

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

/*
 * Basic service endpoint.
 */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'shave-api',
  });
});

/*
 * Database health.
 */
app.get('/health', async (req, res) => {
  try {
    const pool = require('./db');

    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      database: 'connected',
    });
  } catch (err) {
    console.error('Health check failed:', err);

    res.status(500).json({
      status: 'error',
      database: 'error',
      message: err.message,
    });
  }
});

/*
 * Load application modules after Express is initialized.
 *
 * This allows the process to remain available long enough
 * to expose a useful startup diagnostic if a dependency fails.
 */
let plaidModule = null;
let syncModule = null;
let moduleLoadError = null;

try {
  plaidModule = require('./plaidClient');
  syncModule = require('./sync');

  console.log('Application modules loaded successfully.');
} catch (err) {
  moduleLoadError = err;

  console.error('APPLICATION MODULE LOAD FAILURE');
  console.error(err);
  console.error(err.stack);
}

/*
 * Diagnostic endpoint.
 *
 * Does not expose secrets.
 */
app.get('/diagnostics', (req, res) => {
  const diagnostics = {
    status: moduleLoadError ? 'degraded' : 'ok',
    service: 'shave-api',
    modules_loaded: {
      plaidClient: Boolean(plaidModule),
      sync: Boolean(syncModule),
    },
    environment: {
      NODE_ENV: process.env.NODE_ENV || null,
      PLAID_ENV: process.env.PLAID_ENV || null,
      PORT: process.env.PORT || null,
      DATABASE_URL_present: Boolean(
        process.env.DATABASE_URL
      ),
      PLAID_CLIENT_ID_present: Boolean(
        process.env.PLAID_CLIENT_ID
      ),
      PLAID_SECRET_present: Boolean(
        process.env.PLAID_SECRET
      ),
      ENCRYPTION_KEY_present: Boolean(
        process.env.ENCRYPTION_KEY
      ),
    },
  };

  if (moduleLoadError) {
    diagnostics.module_error = {
      message: moduleLoadError.message,
      name: moduleLoadError.name,
    };
  }

  res.status(moduleLoadError ? 500 : 200).json(
    diagnostics
  );
});

/*
 * Transaction synchronization.
 *
 * GET and POST are exposed because the scheduled sync
 * endpoint may be invoked by the existing deployment workflow.
 */
if (syncModule?.runSync) {
  app.get('/sync', syncModule.runSync);
  app.post('/sync', syncModule.runSync);
}

/*
 * Explicit 404 response.
 */
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Not found',
    path: req.originalUrl,
  });
});

/*
 * Keep the process alive on Render and bind to all interfaces.
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Shave API listening on port ${PORT}`
  );
});
