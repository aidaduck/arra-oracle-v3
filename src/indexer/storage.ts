/**
 * Document storage: SQLite + vector store batching
 */

import { Database } from 'bun:sqlite';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import type { VectorStoreAdapter } from '../vector/types.ts';
import type { OracleDocument } from '../types.ts';

// Must match index-incremental.ts's hash() exactly — that script diffs
// against this value to decide which docs are already current. A full
// reindex that skips writing content_hash makes every doc look "changed"
// to the incremental indexer, even ones that just got embedded seconds ago.
const hash = (s: string) => Bun.hash(s).toString(36);

/**
 * Store documents in SQLite + vector store
 * Uses Drizzle for type-safe inserts and sets createdBy: 'indexer'
 */
export async function storeDocuments(
  sqlite: Database,
  db: BunSQLiteDatabase<typeof schema>,
  vectorClient: VectorStoreAdapter | null,
  project: string | null,
  documents: OracleDocument[]
): Promise<void> {
  const now = Date.now();

  // Prepare FTS statements. FTS5 virtual tables have no UNIQUE constraint on
  // the id column (it's UNINDEXED), so INSERT OR REPLACE doesn't dedupe —
  // every reindex accumulates duplicates. Delete-then-insert instead.
  // (Drift discovered 2026-04-16: oracle_fts had 1268 rows for 141 unique ids
  // after 9 reindex passes.)
  const deleteFts = sqlite.prepare(`DELETE FROM oracle_fts WHERE id = ?`);
  const insertFts = sqlite.prepare(`
    INSERT INTO oracle_fts (id, content, concepts)
    VALUES (?, ?, ?)
  `);

  // Prepare for vector store
  const ids: string[] = [];
  const contents: string[] = [];
  const metadatas: any[] = [];

  // Wrap SQLite inserts in a transaction for performance + atomicity
  sqlite.exec('BEGIN');
  try {
    for (const doc of documents) {
      // SQLite metadata - use doc.project if available, fall back to repo project
      const docProject = (doc.project || project)?.toLowerCase();

      // Drizzle upsert with createdBy: 'indexer'
      db.insert(oracleDocuments)
        .values({
          id: doc.id,
          type: doc.type,
          sourceFile: doc.source_file,
          concepts: JSON.stringify(doc.concepts),
          createdAt: doc.created_at,
          updatedAt: doc.updated_at,
          indexedAt: now,
          project: docProject,
          createdBy: 'indexer',
        })
        .onConflictDoUpdate({
          target: oracleDocuments.id,
          set: {
            type: doc.type,
            sourceFile: doc.source_file,
            concepts: JSON.stringify(doc.concepts),
            updatedAt: doc.updated_at,
            indexedAt: now,
            project: docProject,
          }
        })
        .run();

      // SQLite FTS (raw SQL required for FTS5): delete then insert to avoid
      // duplicates across re-index runs.
      deleteFts.run(doc.id);
      insertFts.run(
        doc.id,
        doc.content,
        doc.concepts.join(' ')
      );

      // Vector store metadata (must be primitives, not arrays)
      ids.push(doc.id);
      contents.push(doc.content);
      metadatas.push({
        type: doc.type,
        source_file: doc.source_file,
        concepts: doc.concepts.join(','),
        content_hash: hash(doc.content)
      });
    }
    sqlite.exec('COMMIT');
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }

  // Batch insert to vector store in chunks of 100 (skip if no client)
  if (!vectorClient) {
    console.log('Skipping vector indexing (SQLite-only mode)');
    return;
  }

  // Incremental skip (2026-08-05, Myst — cli.ts reindex pass): SQLite/FTS is
  // always refreshed above (cheap, keeps keyword search fresh). The expensive
  // part is the vector-embed call, so before batching we read back the
  // content_hash the adapter already stores for each doc and drop any doc
  // whose hash matches — mirroring index-incremental.ts's diff. Adapters that
  // don't expose getContentHashes() fall back to embedding everything (old
  // behavior, no regression).
  let toEmbed = ids;
  let toEmbedContents = contents;
  let toEmbedMetadatas = metadatas;
  if (typeof vectorClient.getContentHashes === 'function') {
    const existingHashes = await vectorClient.getContentHashes();
    const keep: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (existingHashes.get(ids[i]) !== metadatas[i].content_hash) keep.push(i);
    }
    if (keep.length < ids.length) {
      toEmbed = keep.map(i => ids[i]);
      toEmbedContents = keep.map(i => contents[i]);
      toEmbedMetadatas = keep.map(i => metadatas[i]);
      console.log(`[Incremental] ${ids.length - keep.length}/${ids.length} docs unchanged — skipped vector embed`);
    }
  }

  const BATCH_SIZE = 100;
  let vectorSuccess = true;

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batchIds = toEmbed.slice(i, i + BATCH_SIZE);
    const batchContents = toEmbedContents.slice(i, i + BATCH_SIZE);
    const batchMetadatas = toEmbedMetadatas.slice(i, i + BATCH_SIZE);

    try {
      const vectorDocs = batchIds.map((id, idx) => ({
        id,
        document: batchContents[idx],
        metadata: batchMetadatas[idx]
      }));
      await vectorClient.addDocuments(vectorDocs);
      console.log(`Vector batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)} stored`);
    } catch (error) {
      console.error(`Vector batch failed:`, error);
      vectorSuccess = false;
    }
  }

  console.log(`Stored in SQLite${vectorSuccess ? ` + ${vectorClient.name}` : ` (${vectorClient.name} failed)`}${toEmbed.length < ids.length ? ` (${ids.length - toEmbed.length} unchanged skipped)` : ''}`);
}
