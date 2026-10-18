import { app } from './app.js';
import { jwtSecret } from './auth.js';
import { initDb, pool } from './db.js';
import { processOutboxBatch } from './outbox.js';

const port = Number(process.env.PORT || 4000);
let server;
let workerBusy = false;

async function start() {
  jwtSecret();
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await initDb();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastError) throw lastError;

  server = app.listen(port, () => console.log(`API listening on ${port}`));
  const timer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await processOutboxBatch();
    } catch (error) {
      console.error('Outbox worker batch failed:', error.message);
    } finally {
      workerBusy = false;
    }
  }, 1000);

  const shutdown = async () => {
    clearInterval(timer);
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('Application startup failed:', error.message);
  process.exit(1);
});
