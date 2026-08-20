import 'dotenv/config';
import app from './app.js';
import { env } from './src/config/env.js';
import { closePool, verifyConnection } from './src/database/pool.js';
import logger from './src/utils/logger.js';

// Bind to process.env.PORT or fallback to env.PORT (default 5005)
const PORT = Number(process.env.PORT) || Number(env.PORT) || 5005;
const HOST = '0.0.0.0';

/* Checked once at boot. A bad DATABASE_URL should be a startup failure with a
   clear message, not a 500 on whoever tries to sign in first. Failing to
   connect does not stop the server: the health endpoint still needs to answer
   so the platform reports the instance rather than restarting it forever. */
verifyConnection().catch((err: Error) => {
  logger.error(`Could not reach Postgres: ${err.message}`);
  logger.error('Auth endpoints will fail until DATABASE_URL is reachable.');
});

const server = app.listen(PORT, HOST, () => {
  logger.info(`🚀 Server running in ${env.NODE_ENV} mode on http://${HOST}:${PORT}`);
});

/* Cloud Run sends SIGTERM before it stops an instance. Draining in-flight
   requests and closing the pool keeps a deploy from cutting someone off
   mid-request and from leaving connections held on the database. */
const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down.`);
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  /* If something refuses to let go, do not hang forever. */
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (err: any) => {
  logger.error('UNHANDLED REJECTION! Shutting down...');
  logger.error(err?.name, err?.message);
  server.close(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: any) => {
  logger.error('UNCAUGHT EXCEPTION! Shutting down...');
  logger.error(err);
  process.exit(1);
});
