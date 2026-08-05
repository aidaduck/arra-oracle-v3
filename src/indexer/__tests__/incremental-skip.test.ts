/**
 * Incremental reindex skip — storeDocuments with getContentHashes
 *
 * Verifies that storeDocuments filters out already-current docs from the
 * vector-embed path when the adapter exposes getContentHashes(), while keeping
 * the SQLite/FTS path unconditional. Uses mock adapter — no vec0/Ollama needed.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../db/schema.ts';
import { storeDocuments } from '../../indexer/storage.ts';

function createSqlite() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE oracle_documents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_file TEXT NOT NULL,
      concepts TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      superseded_by TEXT,
      superseded_at INTEGER,
      superseded_reason TEXT,
      origin TEXT,
      project TEXT,
      created_by TEXT
    );
    CREATE VIRTUAL TABLE oracle_fts USING fts5(
      id UNINDEXED,
      content,
      concepts
    );
    PRAGMA user_version = 1
  `);
  return sqlite;
}

function mockAdapter(existingHashes: Record<string, string>) {
  return {
    name: 'mock',
    connect: mock(),
    close: mock(),
    ensureCollection: mock(),
    deleteCollection: mock(),
    addDocuments: mock().mockResolvedValue(undefined),
    query: mock(),
    queryById: mock(),
    getStats: mock().mockResolvedValue({ count: 0 }),
    getCollectionInfo: mock().mockResolvedValue({ count: 0, name: 'test' }),
    getContentHashes: mock().mockResolvedValue(new Map(Object.entries(existingHashes))),
  };
}

function makeDoc(id: string, content: string, extra: Record<string, any> = {}) {
  return {
    id,
    type: 'test',
    content,
    source_file: `${id}.md`,
    concepts: ['test'],
    created_at: Date.now(),
    updated_at: Date.now(),
    project: 'test-project',
    ...extra,
  };
}

describe('storeDocuments — incremental skip', () => {
  test('skips unchanged docs, embeds changed + new only', async () => {
    const sqlite = createSqlite();
    const db = drizzle(sqlite, { schema });

    // existing hashes: unchanged_1 matches, unchanged_2 matches, none for changed_1/new_1
    const hash = (s: string) => Bun.hash(s).toString(36);
    const adapter = mockAdapter({
      unchanged_1: hash('unchanged content 1'),
      unchanged_2: hash('unchanged content 2'),
    });

    const docs = [
      makeDoc('unchanged_1', 'unchanged content 1'),
      makeDoc('changed_1', 'UPDATED content — different hash'),
      makeDoc('new_1', 'brand new doc'),
    ];

    await storeDocuments(sqlite, db, adapter as any, 'test-project', docs as any);

    // addDocuments should have been called with only changed_1 + new_1
    expect(adapter.addDocuments).toHaveBeenCalledTimes(1);
    const called = adapter.addDocuments.mock.calls[0][0] as any[];
    const ids = called.map((d: any) => d.id).sort();
    expect(ids).toEqual(['changed_1', 'new_1']);
  });

  test('embeds everything when adapter lacks getContentHashes (regression guard)', async () => {
    const sqlite = createSqlite();
    const db = drizzle(sqlite, { schema });

    const addDocuments = mock().mockResolvedValue(undefined);
    const plainAdapter = {
      name: 'mock-plain',
      connect: mock(),
      close: mock(),
      ensureCollection: mock(),
      deleteCollection: mock(),
      addDocuments,
      query: mock(),
      queryById: mock(),
      getStats: mock().mockResolvedValue({ count: 0 }),
      getCollectionInfo: mock().mockResolvedValue({ count: 0, name: 'test' }),
      // no getContentHashes
    };

    const docs = [
      makeDoc('a', 'content a'),
      makeDoc('b', 'content b'),
    ];

    await storeDocuments(sqlite, db, plainAdapter as any, 'test-project', docs as any);

    expect(addDocuments).toHaveBeenCalledTimes(1);
    const called = addDocuments.mock.calls[0][0] as any[];
    expect(called).toHaveLength(2);
  });

  test('embeds zero when everything is current', async () => {
    const sqlite = createSqlite();
    const db = drizzle(sqlite, { schema });

    const hash = (s: string) => Bun.hash(s).toString(36);
    const adapter = mockAdapter({
      doc_a: hash('content a'),
      doc_b: hash('content b'),
    });

    const docs = [
      makeDoc('doc_a', 'content a'),
      makeDoc('doc_b', 'content b'),
    ];

    await storeDocuments(sqlite, db, adapter as any, 'test-project', docs as any);

    // When every doc is unchanged, addDocuments should not be called
    expect(adapter.addDocuments).toHaveBeenCalledTimes(0);
  });
});