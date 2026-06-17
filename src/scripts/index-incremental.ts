#!/usr/bin/env bun
/**
 * Incremental embedding indexer.
 *
 * Unlike index-model.ts (destructive full reindex), this:
 *   - embeds ONLY docs that are new or whose content changed (hash-diff)
 *   - skips unchanged docs (saves API quota + compute)
 *   - is non-destructive + resumable (commit per batch; safe to re-run / Ctrl-C)
 *   - throttles between batches to respect per-minute API quota
 *
 * Usage:
 *   bun src/scripts/index-incremental.ts gemini
 *   ORACLE_EMBED_BATCH=20 ORACLE_EMBED_SLEEP_MS=1500 bun src/scripts/index-incremental.ts gemini
 */

import { Database } from 'bun:sqlite';
import { createVectorStore, getEmbeddingModels } from '../vector/factory.ts';
import { DB_PATH } from '../config.ts';
// NOTE: do NOT import db/index.ts — it opens a Database at module load, which
// would beat the adapter's Database.setCustomSQLite() call and break the
// sqlite-vec extension load. We read oracle.db with a raw Database below.

const modelKey = process.argv[2];
const models = getEmbeddingModels();

if (!modelKey || !models[modelKey]) {
  console.error(`Usage: bun src/scripts/index-incremental.ts <model>`);
  console.error(`Available: ${Object.keys(models).join(', ')}`);
  process.exit(1);
}

const preset = models[modelKey];
const BATCH = parseInt(process.env.ORACLE_EMBED_BATCH || '20', 10);
const SLEEP_MS = parseInt(process.env.ORACLE_EMBED_SLEEP_MS || '1500', 10);
const MAX = parseInt(process.env.ORACLE_EMBED_MAX || '0', 10); // 0 = no cap (embed all pending)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hash = (s: string) => Bun.hash(s).toString(36);

async function main() {
  console.log(`=== ${modelKey} Incremental Indexer ===`);
  console.log(`Collection: ${preset.collection} | adapter: ${preset.adapter || 'lancedb'} | provider: ${preset.provider || 'ollama'}`);
  console.log(`Batch: ${BATCH} | sleep: ${SLEEP_MS}ms`);

  const store = createVectorStore({
    type: preset.adapter || 'lancedb',
    collectionName: preset.collection,
    embeddingProvider: preset.provider || 'ollama',
    embeddingModel: preset.model,
    ...(preset.dataPath && { dataPath: preset.dataPath }),
  });
  await store.connect();
  await store.ensureCollection();

  // Read already-embedded ids + their stored content_hash directly from the
  // sqlite-vec meta table (plain table — no vec extension needed to read).
  const existing = new Map<string, string>();
  let staleDims = false;
  if (preset.adapter === 'sqlite-vec' && preset.dataPath) {
    const raw = new Database(preset.dataPath);
    try {
      const rows = raw.query(`SELECT id, metadata FROM ${preset.collection}_meta`).all() as Array<{ id: string; metadata: string }>;
      for (const r of rows) {
        try { existing.set(r.id, JSON.parse(r.metadata).content_hash || ''); } catch { existing.set(r.id, ''); }
      }
      // Detect dim mismatch from the vec table's declared schema (works even
      // when empty): parse `float[N]` from its CREATE statement in sqlite_master.
      const schema = raw.query(`SELECT sql FROM sqlite_master WHERE name = ?`).get(`${preset.collection}_vec`) as { sql: string } | null;
      const m = schema?.sql?.match(/float\[(\d+)\]/);
      const curDims = (store as any).embedder?.dimensions;
      if (m && curDims && parseInt(m[1], 10) !== curDims) staleDims = true;
    } catch { /* fresh collection */ }
    raw.close();
  }

  if (staleDims) {
    console.log(`⚠️  Stored dims ≠ current dims → dropping stale collection for clean re-embed`);
    await store.deleteCollection();
    await store.ensureCollection();
    existing.clear();
  }

  // Source docs from oracle.db (FTS join for full content). Raw Database —
  // opened AFTER store.connect() so setCustomSQLite has already run.
  const sqlite = new Database(DB_PATH, { readonly: true });
  const rows = sqlite.prepare(`
    SELECT d.id, d.type, GROUP_CONCAT(f.content, '\n') AS content, d.source_file, d.concepts, d.project
    FROM oracle_documents d
    JOIN oracle_fts f ON d.id = f.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all() as Array<{ id: string; type: string; content: string; source_file: string; concepts: string; project: string | null }>;

  // Collection scoping by source path (e.g. keep MercyX in its own collection)
  let scoped = rows;
  if (preset.sourceInclude) scoped = scoped.filter(r => r.source_file.includes(preset.sourceInclude!));
  if (preset.sourceExclude) scoped = scoped.filter(r => !r.source_file.includes(preset.sourceExclude!));
  if (scoped.length !== rows.length) {
    console.log(`Scope: ${rows.length} → ${scoped.length} docs (include=${preset.sourceInclude || '-'} exclude=${preset.sourceExclude || '-'})`);
  }

  // Diff
  let todo = scoped.filter(r => {
    const h = hash(r.content);
    const prev = existing.get(r.id);
    return prev === undefined || prev !== h;
  });

  const pending = todo.length;
  if (MAX > 0 && todo.length > MAX) todo = todo.slice(0, MAX); // cap per run ("ทีละนิด")
  const skipped = scoped.length - pending;
  console.log(`In scope: ${scoped.length} docs | already current: ${skipped} | pending: ${pending} | this run: ${todo.length}${MAX > 0 ? ` (capped at ${MAX})` : ''}`);
  if (todo.length === 0) { console.log('✅ Nothing to embed — up to date.'); await store.close(); sqlite.close(); return; }

  let done = 0, errors = 0;
  const start = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const docs = batch.map(r => ({
      id: r.id,
      document: r.content,
      metadata: {
        type: r.type,
        source_file: r.source_file,
        concepts: r.concepts,
        content_hash: hash(r.content),
        ...(r.project && { project: r.project }),
      },
    }));
    try {
      await store.addDocuments(docs);   // INSERT OR REPLACE — non-destructive
      done += docs.length;
      const rate = (done / ((Date.now() - start) / 1000)).toFixed(1);
      console.log(`  ${done}/${todo.length} embedded — ${rate}/s`);
    } catch (e) {
      errors++;
      console.error(`  Batch @${i} FAILED:`, e instanceof Error ? e.message : String(e));
    }
    if (i + BATCH < todo.length) await sleep(SLEEP_MS);  // throttle
  }

  const stats = await store.getStats();
  console.log(`\n=== Done === embedded ${done}, errors ${errors}, collection total ${stats.count}`);
  await store.close();
  sqlite.close();
}

main().catch(e => { console.error('Incremental indexer failed:', e); process.exit(1); });
