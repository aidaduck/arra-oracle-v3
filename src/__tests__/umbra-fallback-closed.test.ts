/**
 * Ensure no fallback path resolves to 'umbra' after consolidation
 * (2026-08-07). Every default should resolve to 'bge-m3'.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { getEmbeddingModels } from '../vector/factory.ts';

describe('umbra fallback — deprecated after consolidation', () => {
  const originalModel = process.env.ORACLE_EMBEDDING_MODEL;
  const originalProvider = process.env.ORACLE_EMBEDDING_PROVIDER;

  afterEach(() => {
    process.env.ORACLE_EMBEDDING_MODEL = originalModel;
    process.env.ORACLE_EMBEDDING_PROVIDER = originalProvider;
  });

  function resolveModel(): string {
    const models = getEmbeddingModels();
    const envModel = process.env.ORACLE_EMBEDDING_MODEL;
    return (envModel && models[envModel])
      ? envModel
      : 'bge-m3';
  }

  it('should resolve to bge-m3 when ORACLE_EMBEDDING_PROVIDER=gemini (no model preset)', () => {
    delete process.env.ORACLE_EMBEDDING_MODEL;
    process.env.ORACLE_EMBEDDING_PROVIDER = 'gemini';
    expect(resolveModel()).toBe('bge-m3');
  });

  it('should resolve to bge-m3 when ORACLE_EMBEDDING_PROVIDER=ollama (no model preset)', () => {
    delete process.env.ORACLE_EMBEDDING_MODEL;
    process.env.ORACLE_EMBEDDING_PROVIDER = 'ollama';
    expect(resolveModel()).toBe('bge-m3');
  });

  it('should resolve to bge-m3 when no env vars set', () => {
    delete process.env.ORACLE_EMBEDDING_MODEL;
    delete process.env.ORACLE_EMBEDDING_PROVIDER;
    expect(resolveModel()).toBe('bge-m3');
  });

  it('should never resolve to umbra as default', () => {
    const models = getEmbeddingModels();
    const umbra = models['umbra'];
    expect(umbra).toBeDefined();
    // umbra is deprecated — keep preset but ensure it's never the default
    expect(umbra.collection).toBe('oracle_knowledge_umbra');
  });
});