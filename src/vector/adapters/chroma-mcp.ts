/**
 * ChromaDB MCP Adapter
 *
 * Thin wrapper around existing ChromaMcpClient.
 * "Nothing is Deleted" — the original chroma-mcp.ts stays untouched.
 */

import { ChromaMcpClient } from '../../chroma-mcp.ts';
import type { VectorStoreAdapter, VectorDocument, VectorQueryResult } from '../types.ts';

export class ChromaMcpAdapter implements VectorStoreAdapter {
  readonly name = 'chroma';
  private client: ChromaMcpClient;

  constructor(collectionName: string, dataDir: string, pythonVersion: string = '3.12') {
    this.client = new ChromaMcpClient(collectionName, dataDir, pythonVersion);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ensureCollection(): Promise<void> {
    await this.client.ensureCollection();
  }

  async deleteCollection(): Promise<void> {
    await this.client.deleteCollection();
  }

  async addDocuments(docs: VectorDocument[]): Promise<void> {
    await this.client.addDocuments(docs);
  }

  async query(text: string, limit?: number, where?: Record<string, any>): Promise<VectorQueryResult> {
    return await this.client.query(text, limit, where);
  }

  async queryById(id: string, nResults?: number): Promise<VectorQueryResult> {
    return await this.client.queryById(id, nResults);
  }

  async getStats(): Promise<{ count: number }> {
    return await this.client.getStats();
  }

  async getCollectionInfo(): Promise<{ count: number; name: string }> {
    return await this.client.getCollectionInfo();
  }

  async getAllEmbeddings(limit?: number): Promise<{ ids: string[]; embeddings: number[][]; metadatas: any[] }> {
    return await this.client.getAllEmbeddings(limit);
  }

  async getContentHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    const all = await this.client.getAllEmbeddings(100000);
    for (let i = 0; i < all.ids.length; i++) {
      const meta = all.metadatas[i] || {};
      hashes.set(all.ids[i], meta.content_hash || '');
    }
    return hashes;
  }
}
