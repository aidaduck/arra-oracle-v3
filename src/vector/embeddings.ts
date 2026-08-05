/**
 * Embedding Providers
 *
 * Ported from Nat-s-Agents data-aware-rag.
 * ChromaDB handles embeddings internally; other stores need these.
 */

import type { EmbeddingProvider, EmbeddingProviderType, EmbedType } from './types.ts';

/**
 * Placeholder for ChromaDB's internal embeddings.
 * ChromaDB generates embeddings server-side — this is never called directly.
 */
export class ChromaDBInternalEmbeddings implements EmbeddingProvider {
  readonly name = 'chromadb-internal';
  readonly dimensions = 384; // all-MiniLM-L6-v2 default

  async embed(_texts: string[], _type?: EmbedType): Promise<number[][]> {
    throw new Error('ChromaDB handles embeddings internally. Use addDocuments() directly.');
  }
}

/**
 * Ollama local embeddings
 */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = 'ollama';
  dimensions: number;
  private baseUrl: string;
  private model: string;
  private _dimensionsDetected = false;

  constructor(config: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || 'nomic-embed-text';
    // Known model dimensions (fallback before auto-detect).
    // For unknown models, set to 0 → adapters MUST probe via embed() before
    // creating columns (see #qwen3-dim-fallback issue).
    const KNOWN_DIMS: Record<string, number> = {
      'nomic-embed-text': 768,
      'qwen3-embedding': 1024,                             // 0.6B variant (default tag)
      'qwen3-embedding:0.6b': 1024,
      'qwen3-embedding:4b': 2560,
      'qwen3-embedding:8b': 4096,
      'bge-m3': 1024,
      'bge-m3-lowctx': 1024,  // same weights as bge-m3, num_ctx=1024 only
      'mxbai-embed-large': 1024,
      'all-minilm': 384,
      'qllama/multilingual-e5-large-instruct': 1024,
      'qllama/multilingual-e5-large-instruct:latest': 1024,
      'multilingual-e5-large': 1024,
      'multilingual-e5-large-instruct': 1024,
      'snowflake-arctic-embed2': 1024,
    };
    this.dimensions = KNOWN_DIMS[this.model] || 768;
  }

  async embed(texts: string[], type?: EmbedType): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      // Truncate to ~2000 chars — Thai text uses 2-3x more tokens than English
      let truncated = text.length > 2000 ? text.slice(0, 2000) : text;

      // Instruction prefixes per model family. Wrong protocol = silent
      // 5–30pt cross-language recall regression (observed on qwen3:4b).
      //
      //   - bge-v1.5 / multilingual-e5 → "query: ..." / "passage: ..."
      //     (bge-m3 doesn't strictly require it but tolerates it)
      //   - qwen3-embedding → "Instruct: <task>\nQuery: <q>" on QUERIES ONLY
      //     passages stay raw. https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
      const isQwen3 = this.model.includes('qwen3-embedding');
      const isE5 = this.model.includes('multilingual-e5') || this.model.includes('/e5-');
      const isBge = this.model.includes('bge');

      if (type === 'query') {
        if (isQwen3) {
          truncated = `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${truncated}`;
        } else if (isBge || isE5) {
          truncated = `query: ${truncated}`;
        }
      } else if (type === 'passage') {
        if (isBge || isE5) {
          truncated = `passage: ${truncated}`;
        }
        // qwen3-embedding: passages stay raw per HF model card
      }

      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: truncated }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${error}`);
      }

      const data = await response.json() as { embedding: number[] };
      embeddings.push(data.embedding);

      // Auto-detect dimensions from first response
      if (!this._dimensionsDetected && data.embedding.length > 0) {
        this.dimensions = data.embedding.length;
        this._dimensionsDetected = true;
      }
    }

    return embeddings;
  }
}

/**
 * OpenAI embeddings via API
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(config: { apiKey?: string; model?: string } = {}) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = config.model || 'text-embedding-3-small';
    this.dimensions = this.model === 'text-embedding-3-large' ? 3072 : 1536;

    if (!this.apiKey) {
      throw new Error('OpenAI API key required. Set OPENAI_API_KEY.');
    }
  }

  async embed(texts: string[], _type?: EmbedType): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json() as {
      data: { embedding: number[]; index: number }[];
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}

/**
 * Gemini embeddings via Google AI API.
 *
 * gemini-embedding-2 supports Matryoshka (MRL): outputDimensionality can be
 * truncated from 3072 → 768 with near-identical quality but 4x less storage.
 * Default 768 (override via ORACLE_EMBEDDING_DIMS). Set GEMINI_API_KEY.
 */
export class GeminiEmbeddings implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(config: { apiKey?: string; model?: string; dimensions?: number } = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = config.model || 'gemini-embedding-2';
    this.dimensions = config.dimensions
      || (process.env.ORACLE_EMBEDDING_DIMS ? parseInt(process.env.ORACLE_EMBEDDING_DIMS, 10) : 0)
      || 768;

    if (!this.apiKey) {
      throw new Error('Gemini API key required. Set GEMINI_API_KEY.');
    }
  }

  async embed(texts: string[], _type?: EmbedType): Promise<number[][]> {
    const embeddings: number[][] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    for (const text of texts) {
      const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

      let response: Response;
      // Free tier caps embedContent at ~100 req/min + 1000 req/day.
      // On 429 the API tells us when to retry ("retry in Xs") — honor it and
      // self-pace instead of failing the batch. BUT: distinguish between
      // *rate-limit* (transient ~60s, retry helps) and *daily quota exhaustion*
      // (retry same key = waste 6 × 60s). When @type is QuotaFailure, throw
      // immediately so the outer key-rotation loop gets control right away.
      for (let attempt = 0; ; attempt++) {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text: truncated }] },
            outputDimensionality: this.dimensions,
          }),
        });
        if (response.status !== 429 || attempt >= 6) break;
        const body = await response.text();
        let isQuotaExhaustion = false;
        try {
          const err = JSON.parse(body);
          const details: unknown = err?.error?.details;
          isQuotaExhaustion = Array.isArray(details) &&
            (details as Array<Record<string, unknown>>).some(d =>
              ((d as Record<string, unknown>)?.['@type'] as string | undefined)?.includes('QuotaFailure')
            );
        } catch {}
        if (isQuotaExhaustion) {
          throw new Error(`Gemini API error: ${body}`);
        }
        const m = body.match(/retry in ([\d.]+)s/i);
        const waitMs = Math.ceil((m ? parseFloat(m[1]) : 30) * 1000) + 1000;
        await sleep(waitMs);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${error}`);
      }

      const data = await response.json() as { embedding: { values: number[] } };
      // MRL truncation (<3072) returns un-normalized vectors. Normalize to unit
      // length so cosine/dot-product distance stays correct across backends.
      const vec = data.embedding.values;
      if (this.dimensions < 3072) {
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
        embeddings.push(vec.map(v => v / norm));
      } else {
        embeddings.push(vec);
      }
    }

    return embeddings;
  }
}

/**
 * Create embedding provider from type string
 */
export function createEmbeddingProvider(
  type: EmbeddingProviderType = 'chromadb-internal',
  model?: string
): EmbeddingProvider {
  switch (type) {
    case 'ollama':
      return new OllamaEmbeddings({ model });
    case 'openai':
      return new OpenAIEmbeddings({ model });
    case 'gemini':
      return new GeminiEmbeddings({ model });
    case 'cloudflare-ai': {
      // Dynamic import to avoid requiring CF credentials when not used
      const { CloudflareAIEmbeddings } = require('./adapters/cloudflare-vectorize.ts');
      return new CloudflareAIEmbeddings({ model });
    }
    case 'chromadb-internal':
    default:
      return new ChromaDBInternalEmbeddings();
  }
}
