#!/usr/bin/env bun
/**
 * Import-graph gate for arra-oracle-v3.
 *
 * Walks the static import graph from extension-dependent entry points
 * and FAILS if src/db/index.ts is reachable by any static chain.
 *
 * The module-scope `new Database()` in db/index.ts must NOT fire before
 * setCustomSQLite() has a chance to register the sqlite-vec extension.
 * Static imports of db/index.ts bypass this entirely — the Database opens
 * at module-load time, before a single line of user code runs.
 *
 * This gate catches that class of bug at CI time. It would have caught
 * attempts #2, #3, AND #4 of the Mac ordering bug — none of which any
 * runtime test could detect from the VPS (sqlite-vec loads by default).
 *
 * Usage: bun scripts/import-gate.ts   (exit 1 on violation)
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';

const ROOT = join(import.meta.dir, '..', 'src');

const ROOTS = [
  'src/indexer/cli.ts',
  'src/scripts/index-incremental.ts',
];

const FORBIDDEN = 'src/db/index.ts';

const STATIC_IMPORT_RE = /import\s+(?:\{[^}]*\}\s*|[\w*]+\s*,?\s*)?from\s+['"](\.[^'"]+)['"]/g;
const STATIC_IMPORT_ONLY_RE = /import\s+['"](\.[^'"]+)['"]/g;

const visited = new Set<string>();
const chain: string[] = [];
let errors = 0;

function resolveImport(fromFile: string, target: string): string | null {
  const d = dirname(fromFile);
  const resolved = resolve(d, target);
  const rel = join(ROOT, resolved.replace(ROOT, ''));

  const candidates = [
    resolved,
    resolved + '.ts',
    resolved + '.tsx',
    join(resolved, 'index.ts'),
    join(resolved, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function collectImports(file: string): string[] {
  const out: string[] = [];
  const src = readFileSync(file, 'utf8');
  let m: RegExpExecArray | null;
  const re1 = new RegExp(STATIC_IMPORT_RE.source, 'g');
  while ((m = re1.exec(src)) !== null) out.push(m[1]);
  const re2 = new RegExp(STATIC_IMPORT_ONLY_RE.source, 'g');
  while ((m = re2.exec(src)) !== null) out.push(m[1]);
  return out;
}

function dfs(file: string): void {
  const normalized = resolve(file);
  if (visited.has(normalized)) return;
  visited.add(normalized);

  if (normalized.endsWith(FORBIDDEN.replace('src/', ''))) {
    errors++;
    console.error(`FAIL: static import chain reaches ${FORBIDDEN}`);
    console.error(`Chain: ${chain.join(' → ')} → ${FORBIDDEN}`);
    return;
  }

  const imports = collectImports(normalized);
  for (const imp of imports) {
    const resolved = resolveImport(normalized, imp);
    if (!resolved) continue;
    chain.push(resolved.replace(ROOT, 'src/'));
    dfs(resolved);
    chain.pop();
  }
}

for (const root of ROOTS) {
  const rootPath = join(ROOT, root.replace('src/', ''));
  if (!existsSync(rootPath)) {
    console.error(`WARN: root not found: ${rootPath}`);
    continue;
  }
  chain.push(root);
  dfs(rootPath);
  chain.pop();
}

if (errors > 0) {
  console.error(`\nimport-gate: ${errors} violation(s) found — db/index.ts must not be statically reachable from CLI entry points`);
  process.exit(1);
}

console.log(`import-gate: OK (${visited.size} files visited, 0 violations)`);