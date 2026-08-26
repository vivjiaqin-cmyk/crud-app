import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, db } from './db/client.js';

// Opening the database before listening means a bad DB_FILE fails at startup
// with a clear error, instead of 500ing the first request that touches it.
db();

const server = createApp().listen(config.port, () => {
  console.log(`crud-app listening on http://localhost:${config.port} (${config.env})`);
  console.log(`database ${config.dbFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}
