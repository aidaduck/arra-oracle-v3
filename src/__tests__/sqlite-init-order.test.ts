/**
 * Import-order gate: sqlite-init.ts MUST be the first import in every
 * entry point that loads the sqlite extension.
 *
 * ESM evaluates imports depth-first in source order. If sqlite-init.ts is
 * the first import, its side effect (Database.setCustomSQLite) runs before
 * any other module can open a Database — eliminating the entire class of
 * "DB opens before setCustomSQLite" bugs (7 attempts proved this).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

type Entry = { path: string; label: string };
const ENTRIES: Entry[] = [
  { path: 'indexer/cli.ts', label: 'cli.ts' },
  { path: 'scripts/index-incremental.ts', label: 'index-incremental.ts' },
];

/**
 * Find the first non-shebang, non-comment import statement in a file.
 * Skips #!/usr/bin/env bun shebang, JSDoc /** and single-line // comments.
 */
function firstImport(filePath: string): string | null {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip shebang, blank, comments
    if (trimmed.startsWith('#!')) continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) continue;
    if (trimmed === '') continue;
    // Found first real code line — must be an import
    if (trimmed.startsWith('import ')) return trimmed;
    return null; // first real line isn't an import
  }
  return null;
}

describe('sqlite-init.ts import order', () => {
  for (const entry of ENTRIES) {
    test(`${entry.label}: first import is sqlite-init.ts`, () => {
      const imp = firstImport(join(ROOT, entry.path));
      expect(imp).toBeString();
      expect(imp).toMatch(/from\s+['"]\.\.\/sqlite-init\.ts['"]|import\s+['"]\.\.\/sqlite-init\.ts['"]/);
    });
  }
});