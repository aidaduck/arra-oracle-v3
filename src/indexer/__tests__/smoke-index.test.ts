import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OracleIndexer } from '../index.ts';
import type { IndexerConfig } from '../../types.ts';

/**
 * Real end-to-end smoke test for OracleIndexer.index().
 *
 * Regression guard for the recurring ordering bug family: constructor must NOT
 * open oracle.db before vectorClient.connect(), and openMainDb() must be
 * awaited before this.sqlite/this.db are used. 3 prior commits shipped green
 * tests but crashed at runtime because NO test constructed OracleIndexer or
 * called .index(). This test actually runs index() against a temp fixture.
 *
 * Uses SQLite-only mode (no ORACLE_VECTOR_DB => vectorClient stays null),
 * which is exactly the path that triggers setIndexingStatus/this.db.select
 * immediately after openMainDb().
 */

let tmp: string;
let config: IndexerConfig;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-idx-smoke-'));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('OracleIndexer.index() runs to completion on a temp ψ/memory fixture', async () => {
  // Build fixture: ψ/memory/{resonance,learnings,retrospectives,distillations}
  const psi = path.join(tmp, 'ψ');
  const memory = path.join(psi, 'memory');
  for (const sub of ['resonance', 'learnings', 'retrospectives', 'distillations']) {
    fs.mkdirSync(path.join(memory, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(memory, 'resonance', 'smoke-hello.md'),
    '---\ntitle: Smoke Hello\ntags: [smoke]\n---\n\nA smoke-test resonance doc.\n',
  );
  fs.writeFileSync(
    path.join(memory, 'learnings', 'smoke-learn.md'),
    '---\ntitle: Smoke Lesson\n---\n\nA lesson from the smoke test.\n',
  );

  config = {
    repoRoot: tmp,
    dbPath: path.join(tmp, 'oracle.db'),
    chromaPath: path.join(tmp, 'chroma'),
    sourcePaths: {
      resonance: 'ψ/memory/resonance',
      learnings: 'ψ/memory/learnings',
      retrospectives: 'ψ/memory/retrospectives',
      distillations: 'ψ/memory/distillations',
    },
  };

  // SQLite-only (no ORACLE_VECTOR_DB -> lancedb -> vectorClient null in index())
  delete process.env.ORACLE_VECTOR_DB;

  const indexer = new OracleIndexer(config);
  // Constructor must NOT have opened the DB yet (lazy) — the core ordering fix.
  expect((indexer as { sqlite?: unknown }).sqlite).toBeUndefined();

  await indexer.index();
  await indexer.close();

  // DB should now exist on disk and be non-trivial.
  expect(fs.existsSync(config.dbPath)).toBe(true);
  const size = fs.statSync(config.dbPath).size;
  expect(size).toBeGreaterThan(0);
});