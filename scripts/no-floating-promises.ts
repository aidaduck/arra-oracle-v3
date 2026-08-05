#!/usr/bin/env bun
/**
 * No-floating-promises gate for arra-oracle-v3.
 *
 * Detects calls to known async "lazy init / connect" methods that are awaited
 * at some call sites but NOT at others — the exact class of bug that slipped
 * through 3 straight green-but-broken commits (openMainDb() made async but
 * called without await at a sibling site).
 *
 * Rule: a line whose sole statement is a call to one of these methods MUST
 * start with `await`. Multi-line chains and await-on-previous-line are also
 * caught conservatively (flagged for human review).
 *
 * Usage: bun scripts/no-floating-promises.ts   (exit 1 on violation)
 */

import { readdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';

// Methods that return a Promise and MUST be awaited wherever called.
const REQUIRED_AWAIT = ['openMainDb(', 'ensureCollection(', 'vectorClient.connect(', 'vectorStore.connect('];

const ROOT = join(import.meta.dir, '..', 'src');
const errors: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (extname(e.name) === '.ts' && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const method of REQUIRED_AWAIT) {
      if (!line.includes(method)) continue;
      const t = line.trim();
      // Skip: comments, template strings, return statements, or already-awaited.
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('`') || t.startsWith('await ')) continue;
      if (t.startsWith('return ')) continue;
      // Skip method definitions / interface signatures: contain `async` or `(): Promise<`.
      if (/\basync\s/.test(t)) continue;
      if (t.includes(method) && /\([^)]*\)\s*:\s*Promise</.test(t)) continue;
      // Flag if the call has no `await` anywhere on the line.
      if (!/await\s/.test(line)) {
        errors.push(`${file}:${i + 1}: un-awaited ${method.replace('(', '')} -> ${t}`);
      }
    }
  }
}

if (errors.length) {
  console.error(`no-floating-promises: ${errors.length} violation(s)`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.error('no-floating-promises: clean ✅');
process.exit(0);