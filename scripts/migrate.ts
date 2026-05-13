/**
 * CLI 迁移脚本：`npm run db:migrate`
 *
 * 将 ./drizzle/migrations 下生成的 SQL 应用到 ./data.db
 */

import { closeDatabase, openDatabase, runMigrations } from '../lib/db';

function main(): void {
  const { db } = openDatabase();
  console.log('Running migrations...');
  runMigrations(db);
  console.log('Migrations complete.');
  closeDatabase();
}

main();
