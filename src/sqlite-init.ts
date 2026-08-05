/**
 * Side-effect module — register custom SQLite before any Database is created.
 *
 * ESM evaluates imports depth-first in source order. THIS IMPORT MUST BE THE
 * FIRST import in every entry point that needs sqlite extension loading (Mac):
 *
 * ```ts
 * import '../sqlite-init.ts';     // ← ต้องอยู่ก่อน import อื่นทุกตัว
 * import fs from 'fs';
 * ...
 * ```
 *
 * Bun's bundled SQLite disables dynamic extension loading. On macOS, this
 * registers the Homebrew/provided sqlite (which allows .dylib loading) so
 * that sqlite-vec extensions can load successfully. On Linux, no custom lib
 * is found (paths are .dylib only) → no-op. Already-set → no-op (try/catch).
 *
 * This eliminates the entire class of "DB opens before setCustomSQLite" bugs
 * because the custom sqlite is registered at the very first instant of process
 * startup, before any module can import config.ts, handler.ts, db/index.ts,
 * or any other file that might open a Database.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';

const customLib = process.env.ORACLE_SQLITE_LIB
  || ['/usr/local/opt/sqlite/lib/libsqlite3.dylib',
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib']
       .find(p => { try { return existsSync(p); } catch { return false; } });

if (customLib) {
  try { Database.setCustomSQLite(customLib); } catch { /* already set / unsupported */ }
}