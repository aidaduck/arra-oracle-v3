/**
 * Oracle v2 Indexer
 *
 * Parses markdown files from psi/memory and creates:
 * 1. SQLite index (source of truth for metadata)
 * 2. FTS5 full-text index
 *
 * Vector indexing (LanceDB) is handled separately by src/scripts/index-model.ts
 * to keep a single source of truth for the canonical LanceDB path + collection
 * (via the EMBEDDING_MODELS registry used by the server).
 */

import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { eq, or, isNull, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import { createDatabase } from '../db/index.ts';
import { detectProject } from '../server/project-detect.ts';
import type { OracleDocument, IndexerConfig } from '../types.ts';

import { setIndexingStatus } from './status.ts';
import { backupDatabase } from './backup.ts';
import { parseResonanceFile, parseLearningFile, parseRetroFile, parseDistillationFile } from './parser.ts';
import { collectDocuments, collectSecurityCorpus } from './collectors.ts';
import { storeDocuments } from './storage.ts';
import { createVectorStore, getEmbeddingModels } from '../vector/factory.ts';
import { COLLECTION_NAME } from '../const.ts';
import type { VectorStoreAdapter } from '../vector/types.ts';

export class OracleIndexer {
  private sqlite: Database;
  private db: BunSQLiteDatabase<typeof schema>;
  private config: IndexerConfig;
  private project: string | null;
  private seenContentHashes: Set<string> = new Set();
  private vectorClient: VectorStoreAdapter | null = null;

  constructor(config: IndexerConfig) {
    this.config = config;
    const { sqlite, db } = createDatabase(config.dbPath);
    this.sqlite = sqlite;
    this.db = db;
    this.project = detectProject(config.repoRoot);
    console.log(`[Indexer] Detected project: ${this.project || '(universal)'}`);
  }

  /**
   * Main indexing workflow
   */
  async index(): Promise<void> {
    console.log('Starting Oracle indexing...');
    this.seenContentHashes.clear();

    setIndexingStatus(this.sqlite, this.config, true, 0, 100);
    backupDatabase(this.sqlite, this.config);

    // Safety: verify the source directory layout exists. If ψ/memory/ is
    // completely missing, abort before smart-delete to prevent wiping the DB
    // when the indexer is launched from the wrong working directory.
    const psiMemoryDir = path.join(this.config.repoRoot, '\u03c8', 'memory');
    const existingIndexerDocCount = this.db.select({ id: oracleDocuments.id })
      .from(oracleDocuments)
      .where(or(eq(oracleDocuments.createdBy, 'indexer'), isNull(oracleDocuments.createdBy)))
      .all().length;

    if (!fs.existsSync(psiMemoryDir) && existingIndexerDocCount > 0) {
      throw new Error(
        `Refusing to index: ${psiMemoryDir} does not exist but DB has ${existingIndexerDocCount} indexer docs. ` +
        `Set ORACLE_REPO_ROOT or run from a directory containing ψ/memory/ to avoid data loss.`
      );
    }

    // Collect documents from all source types
    const shared = { config: this.config, seenContentHashes: this.seenContentHashes };
    let documents: OracleDocument[] = [
      ...collectDocuments({ ...shared, subdir: 'resonance', parseFn: parseResonanceFile, label: 'resonance' }),
      ...collectDocuments({ ...shared, subdir: 'learnings', parseFn: parseLearningFile, label: 'learning' }),
      ...collectDocuments({ ...shared, subdir: 'retrospectives', parseFn: parseRetroFile, label: 'retrospective' }),
      ...collectDocuments({ ...shared, subdir: 'distillations', parseFn: parseDistillationFile, label: 'distillation' }),
      ...collectSecurityCorpus(shared),
    ];

    // Drop documents whose source_file matches an exclude pattern (e.g. nested
    // project psi dirs that should be indexed elsewhere, not in this shared DB).
    const excludePatterns = (this.config.sourceExclude || '').split(',').map(p => p.trim()).filter(Boolean);
    if (excludePatterns.length > 0) {
      const beforeCount = documents.length;
      documents = documents.filter(d => !excludePatterns.some(p => d.source_file.includes(p)));
      if (documents.length !== beforeCount) {
        console.log(`[Indexer] sourceExclude dropped ${beforeCount - documents.length} documents`);
      }
    }

    // Safety: if we found zero source documents but the DB has existing
    // indexer-created content, abort rather than smart-deleting everything.
    if (documents.length === 0 && existingIndexerDocCount > 0) {
      throw new Error(
        `Refusing to index: found 0 source documents but DB has ${existingIndexerDocCount} indexer docs. ` +
        `Check that ψ/memory/ contains .md files and ORACLE_REPO_ROOT points to the correct location.`
      );
    }

    // Smart deletion: remove indexer-created docs whose source file no longer exists
    const allIndexerDocs = this.db.select({ id: oracleDocuments.id, sourceFile: oracleDocuments.sourceFile })
      .from(oracleDocuments)
      .where(or(eq(oracleDocuments.createdBy, 'indexer'), isNull(oracleDocuments.createdBy)))
      .all();

    const idsToDelete = allIndexerDocs
      .filter(d => !fs.existsSync(path.join(this.config.repoRoot, d.sourceFile)))
      .map(d => d.id);

    // Safety: if smart-delete would drop more than half of existing indexer
    // docs, we're almost certainly running from the wrong repoRoot — the docs
    // on disk at this repoRoot just don't match what's in the DB. Abort rather
    // than wiping historical data. Set ORACLE_FORCE_REINDEX=1 to override.
    const forceFlag = process.env.ORACLE_FORCE_REINDEX === '1';
    if (
      !forceFlag &&
      allIndexerDocs.length > 0 &&
      idsToDelete.length / allIndexerDocs.length > 0.5
    ) {
      throw new Error(
        `Refusing to delete ${idsToDelete.length}/${allIndexerDocs.length} docs (>50%). ` +
        `repoRoot="${this.config.repoRoot}" likely doesn't match the source files this DB was built from. ` +
        `Set ORACLE_REPO_ROOT to the correct path, or ORACLE_FORCE_REINDEX=1 to override.`
      );
    }

    console.log(`Smart delete: ${idsToDelete.length} stale docs (preserving oracle_learn)`);

    if (idsToDelete.length > 0) {
      this.db.delete(oracleDocuments).where(inArray(oracleDocuments.id, idsToDelete)).run();
      const BATCH_SIZE = 500;
      for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
        const batch = idsToDelete.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        this.sqlite.prepare(`DELETE FROM oracle_fts WHERE id IN (${placeholders})`).run(...batch);
      }
    }

    // Connect vector store for supported backends. Default stays SQLite-only
    // (null) to avoid regressing existing installs that don't have a store.
    // Collection name is resolved from the model registry (getEmbeddingModels())
    // rather than hardcoded per-provider, so any preset (bge-m3, umbra, etc.)
    // writes to its own collection automatically. ORACLE_EMBEDDING_MODEL is
    // only treated as a preset key if it actually names one — existing
    // installs set it to a raw provider model id (e.g. 'gemini-embedding-2'),
    // which must fall through to the provider-based default instead.
    const vectorType = process.env.ORACLE_VECTOR_DB || 'lancedb';
    const models = getEmbeddingModels();
    const envModel = process.env.ORACLE_EMBEDDING_MODEL;
    const modelName = (envModel && models[envModel])
      ? envModel
      : (process.env.ORACLE_EMBEDDING_PROVIDER === 'gemini' ? 'umbra' : 'bge-m3');
    if (vectorType === 'chroma' || vectorType === 'sqlite-vec') {
      const preset = models[modelName];
      const collectionName = preset?.collection || COLLECTION_NAME;
      this.vectorClient = createVectorStore({ collectionName });
      await this.vectorClient.connect();
      await this.vectorClient.ensureCollection();
      console.log(`[Indexer] Vector client: ${this.vectorClient.name} → ${collectionName}`);
    } else {
      this.vectorClient = null;
    }

    try {
      await storeDocuments(this.sqlite, this.db, this.vectorClient, this.project, documents);
    } finally {
      if (this.vectorClient) {
        await this.vectorClient.close();
        this.vectorClient = null;
      }
    }

    setIndexingStatus(this.sqlite, this.config, false, documents.length, documents.length);
    console.log(`Indexed ${documents.length} documents (SQLite + FTS5)` + (vectorType === 'chroma' ? ' + Chroma' : vectorType === 'sqlite-vec' ? ` + ${modelName}` : ''));
    console.log('Indexing complete!');
  }

  /** Close database connections */
  async close(): Promise<void> {
    this.sqlite.close();
  }
}
