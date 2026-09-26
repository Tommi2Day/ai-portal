import { embedMany, type EmbeddingModel } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { providers, settings, type Provider } from '../db/schema.js';
import { decryptJson } from '../crypto.js';

export interface EmbeddingSettings {
  providerId: string;
  modelId: string;
  /** Optional: request a smaller vector (Titan v2, OpenAI text-embedding-3). */
  dimensions?: number;
}

export const EMBEDDING_PRESETS: Record<string, { modelId: string; label: string; dimensions?: number }[]> = {
  bedrock: [
    { modelId: 'amazon.titan-embed-text-v2:0', label: 'Amazon Titan Text Embeddings v2 (1024)', dimensions: 1024 },
    { modelId: 'cohere.embed-multilingual-v3', label: 'Cohere Embed Multilingual v3 (1024)' },
  ],
  openai_compatible: [
    { modelId: 'bge-m3', label: 'BGE-M3 lokal (Ollama/TEI, 1024, mehrsprachig)' },
    { modelId: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small (1536)' },
  ],
  github: [{ modelId: 'openai/text-embedding-3-small', label: 'text-embedding-3-small via GitHub Models (1536)' }],
};

export async function getEmbeddingSettings(): Promise<EmbeddingSettings | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'embedding'));
  return (row?.value as EmbeddingSettings) ?? null;
}

export async function setEmbeddingSettings(v: EmbeddingSettings) {
  await db.insert(settings).values({ key: 'embedding', value: v })
    .onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: new Date() } });
}

function modelFor(p: Provider, s: EmbeddingSettings): EmbeddingModel {
  const sec = decryptJson<{ apiKey?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }>(p.secretEnc, {});
  switch (p.type) {
    case 'bedrock':
      return createAmazonBedrock({
        region: p.region || 'eu-central-1', apiKey: sec.apiKey || undefined,
        accessKeyId: sec.accessKeyId || undefined, secretAccessKey: sec.secretAccessKey || undefined, sessionToken: sec.sessionToken || undefined,
        baseURL: p.baseUrl || undefined,
      }).embeddingModel(s.modelId);
    case 'github': {
      const org = p.options?.org;
      const base = p.baseUrl || (org ? `https://models.github.ai/orgs/${org}/inference` : 'https://models.github.ai/inference');
      return createOpenAICompatible({ name: 'github', baseURL: base, apiKey: sec.apiKey }).embeddingModel(s.modelId);
    }
    case 'openai_compatible':
      return createOpenAICompatible({ name: 'custom', baseURL: p.baseUrl!, apiKey: sec.apiKey }).embeddingModel(s.modelId);
    case 'anthropic':
      throw new Error('Anthropic bietet keine Embedding-Modelle an – bitte Bedrock, GitHub oder einen OpenAI-kompatiblen Endpunkt wählen');
  }
}

export interface Embedder {
  /** Stable identifier stored with each chunk; changing it triggers re-indexing. */
  key: string;
  embed(values: string[]): Promise<number[][]>;
}

export async function getEmbedder(): Promise<Embedder | null> {
  const s = await getEmbeddingSettings();
  if (!s) return null;
  const [p] = await db.select().from(providers).where(eq(providers.id, s.providerId));
  if (!p) throw new Error('Embedding-Anbieter existiert nicht mehr');
  const model = modelFor(p, s);
  const providerOptions: Record<string, { dimensions: number }> | undefined = s.dimensions
    ? { [p.type === 'bedrock' ? 'bedrock' : 'openaiCompatible']: { dimensions: s.dimensions } }
    : undefined;
  return {
    key: `${p.id}:${s.modelId}:${s.dimensions ?? 'default'}`,
    async embed(values) {
      const out: number[][] = [];
      for (let i = 0; i < values.length; i += 64) {
        const { embeddings } = await embedMany({ model, values: values.slice(i, i + 64), maxParallelCalls: 2, providerOptions });
        out.push(...embeddings);
      }
      return out;
    },
  };
}
