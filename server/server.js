// Entry point. Pulls the saved logbook/state back from GitHub (if configured)
// BEFORE the app loads, because the app reads its data files as it starts.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (_) {}

const persist = require('./lib/persist');

persist.hydrate()
  .catch(e => console.log('[persist] restore failed, continuing without it:', e.message))
  .finally(() => {
    require('./app');

    // A redeploy sends SIGTERM first: push any pending save before exiting.
    let stopping = false;
    process.on('SIGTERM', async () => {
      if (stopping) return;
      stopping = true;
      try { await persist.flush(); } catch (_) {}
      process.exit(0);
    });
  });
