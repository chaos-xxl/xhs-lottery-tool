/**
 * SQLite 数据库单例（better-sqlite3 + drizzle-orm）
 *
 * 设计：
 *   - 进程级单例，启动时连一次、整个生命周期复用
 *   - WAL 模式，单用户写入不会卡读
 *   - 支持在测试 / 脚本里显式注入 in-memory 数据库
 */

import path from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data.db');
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle/migrations');

let cached: { db: AppDatabase; sqlite: SqliteDatabase } | null = null;

/**
 * 打开一个数据库连接（单例）。
 *
 * 生产路径：默认写入 `./data.db`
 * 测试路径：传 `:memory:` 得到一个独立的内存数据库
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): {
  db: AppDatabase;
  sqlite: SqliteDatabase;
} {
  if (cached && dbPath === DEFAULT_DB_PATH) {
    return cached;
  }

  const sqlite = new Database(dbPath);
  // WAL + 外键 + 忙等
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  if (dbPath === DEFAULT_DB_PATH) {
    cached = { db, sqlite };
  }

  return { db, sqlite };
}

/**
 * 执行迁移脚本
 *
 * 对接 R21.3：启动时自动执行数据库迁移脚本将 schema 升级到最新版本再对外服务
 */
export function runMigrations(db: AppDatabase, migrationsFolder: string = MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder });
}

/** 关闭连接（测试清理用） */
export function closeDatabase(): void {
  if (cached) {
    cached.sqlite.close();
    cached = null;
  }
}
