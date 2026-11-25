import mysql, { type Pool } from 'mysql2/promise';
import type { AppConfig } from './config.js';

export function createAdminPool(config: AppConfig): Pool {
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_ADMIN_USER,
    password: config.SQLSCRATCHPAD_ADMIN_PASSWORD,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 50,
    connectTimeout: 5_000,
    charset: 'utf8mb4',
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
}

export async function checkDbHealth(pool: Pool): Promise<boolean> {
  try {
    await pool.query({ sql: 'SELECT 1', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
