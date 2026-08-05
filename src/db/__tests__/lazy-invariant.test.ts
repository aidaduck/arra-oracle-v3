/**
 * Invariant: importing db/index.ts must NOT open the database.
 *
 * The module-scope `new Database()` in db/index.ts was the root cause of
 * the Mac sqlite-vec extension loading failure (module-load opens DB before
 * setCustomSQLite registers the extension). LazyProxy defers the open until
 * the first property access.
 *
 * This test is the deterministic invariant that catches all 4 previous
 * attempts that runtime tests could not see (Linux loads extensions by
 * default; Mac doesn't).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Must be set BEFORE any import of config.ts or db/index.ts
const TMP_DIR = mkdtempSync(join(tmpdir(), 'oracle-invariant-lazy-'));
const OLD_DATA_DIR = process.env.ORACLE_DATA_DIR;
const OLD_DB_PATH = process.env.ORACLE_DB_PATH;
process.env.ORACLE_DATA_DIR = TMP_DIR;
process.env.ORACLE_DB_PATH = join(TMP_DIR, 'oracle.db');

describe('lazy database initialization', () => {
  test('importing db/index.ts does not create the database file', async () => {
    const { DB_PATH } = await import('../../config.ts');
    const { sqlite, db } = await import('../index.ts');

    // Assert: importing the module does NOT open the DB
    expect(existsSync(DB_PATH)).toBe(false);
    expect(existsSync(TMP_DIR)).toBe(true); // config.ts may create dir
  });

  test('accessing sqlite property creates the database file', async () => {
    const { DB_PATH } = await import('../../config.ts');
    const { sqlite, db } = await import('../index.ts');

    // Trigger lazy open by accessing sqlite
    sqlite.prepare('SELECT 1').get();

    // Assert: accessing sqlite creates the DB
    expect(existsSync(DB_PATH)).toBe(true);
  });
});

afterAll(() => {
  if (OLD_DATA_DIR) process.env.ORACLE_DATA_DIR = OLD_DATA_DIR;
  else delete process.env.ORACLE_DATA_DIR;
  if (OLD_DB_PATH) process.env.ORACLE_DB_PATH = OLD_DB_PATH;
  else delete process.env.ORACLE_DB_PATH;
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});