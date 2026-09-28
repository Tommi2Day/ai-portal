import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const factory = (name: string) => vi.fn((_o: object) => ({ embeddingModel: (id: string) => ({ sdk: name, id }) }));
  return {
    bedrock: factory('bedrock'),
    compat: factory('openai-compatible'),
    rows: new Map<unknown, unknown[]>(),
    embedMany: vi.fn(async ({ values }: { values: string[] }) => ({ embeddings: values.map((v) => [v.length]) })),
  };
});
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: m.bedrock }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: m.compat }));
vi.mock('ai', async (orig) => ({ ...(await orig<object>()), embedMany: m.embedMany }));
// db.select().from(table).where(...) resolves to the rows registered for that table
vi.mock('../src/db/index.js', () => ({
  db: { select: () => ({ from: (table: unknown) => ({ where: async () => m.rows.get(table) ?? [] }) }) },
  pool: {},
}));

const { getEmbedder, EMBEDDING_PRESETS } = await import('../src/knowledge/embeddings.js');
const { providers, settings } = await import('../src/db/schema.js');
const { encryptJson } = await import('../src/crypto.js');

const provider = (o: object) => ({ id: 'p1', name: 'P', type: 'bedrock', baseUrl: null, region: null, options: {}, secretEnc: null, enabled: true, ...o });
const configure = (p: object, s: object) => { m.rows.set(settings, [{ key: 'embedding', value: { providerId: 'p1', ...s } }]); m.rows.set(providers, [provider(p)]); };

beforeEach(() => { vi.clearAllMocks(); m.rows.clear(); });

describe('getEmbedder', () => {
  it('returns null without embedding settings', async () => {
    expect(await getEmbedder()).toBeNull();
  });

  it('Bedrock: key identifies provider, model and dimensions; batches of 64; dimensions as provider option', async () => {
    configure({ secretEnc: encryptJson({ apiKey: 'k' }) }, { modelId: 'amazon.titan-embed-text-v2:0', dimensions: 1024 });
    const e = (await getEmbedder())!;
    expect(e.key).toBe('p1:amazon.titan-embed-text-v2:0:1024');
    const out = await e.embed(Array.from({ length: 130 }, (_, i) => 'x'.repeat(i)));
    expect(out).toHaveLength(130);
    expect(out[129]).toEqual([129]);
    expect(m.embedMany).toHaveBeenCalledTimes(3);
    expect(m.embedMany.mock.calls[0][0]).toMatchObject({ providerOptions: { bedrock: { dimensions: 1024 } } });
    expect(m.bedrock).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-central-1', apiKey: 'k' }));
  });

  it('GitHub organization endpoint and OpenAI-compatible base URL', async () => {
    configure({ type: 'github', options: { org: 'acme' }, secretEnc: encryptJson({ apiKey: 'ghp' }) }, { modelId: 'openai/text-embedding-3-small' });
    expect((await getEmbedder())!.key).toBe('p1:openai/text-embedding-3-small:default');
    expect(m.compat).toHaveBeenCalledWith({ name: 'github', baseURL: 'https://models.github.ai/orgs/acme/inference', apiKey: 'ghp' });

    configure({ type: 'openai_compatible', baseUrl: 'http://ollama:11434/v1' }, { modelId: 'bge-m3', dimensions: 512 });
    const e = (await getEmbedder())!;
    await e.embed(['a']);
    expect(m.compat).toHaveBeenLastCalledWith({ name: 'custom', baseURL: 'http://ollama:11434/v1', apiKey: undefined });
    expect(m.embedMany.mock.calls[0][0]).toMatchObject({ providerOptions: { openaiCompatible: { dimensions: 512 } } });
  });

  it('rejects Anthropic and a deleted provider', async () => {
    configure({ type: 'anthropic' }, { modelId: 'x' });
    await expect(getEmbedder()).rejects.toThrow('Anthropic bietet keine Embedding-Modelle an');
    m.rows.set(providers, []);
    await expect(getEmbedder()).rejects.toThrow('Embedding-Anbieter existiert nicht mehr');
  });
});

describe('EMBEDDING_PRESETS', () => {
  it('offers Titan v2 with 1024 dimensions for Bedrock', () => {
    expect(EMBEDDING_PRESETS.bedrock[0]).toMatchObject({ modelId: 'amazon.titan-embed-text-v2:0', dimensions: 1024 });
  });
});
