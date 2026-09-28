import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const factory = (name: string) =>
    vi.fn((_opts: Record<string, unknown>) => Object.assign((modelId: string) => ({ sdk: name, modelId }), {
      embeddingModel: (modelId: string) => ({ sdk: name, modelId, embedding: true }),
    }));
  return { anthropic: factory('anthropic'), bedrock: factory('bedrock'), compat: factory('openai-compatible') };
});
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: sdk.anthropic }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: sdk.bedrock }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: sdk.compat }));

const { languageModel, MODEL_PRESETS } = await import('../src/ai/providers.js');
const { encryptJson } = await import('../src/crypto.js');
type Provider = Parameters<typeof languageModel>[0];
type Model = Parameters<typeof languageModel>[1];

const provider = (p: Partial<Provider> & { secret?: object }): Provider => {
  const { secret, ...rest } = p;
  return {
    id: 'p1', name: 'Test', type: 'anthropic', baseUrl: null, region: null, options: {}, enabled: true, createdAt: new Date(),
    secretEnc: secret ? encryptJson(secret) : null, ...rest,
  } as Provider;
};
const model = (modelId: string) => ({ id: 'm1', providerId: 'p1', modelId }) as Model;

beforeEach(() => vi.clearAllMocks());

describe('languageModel', () => {
  it('Anthropic: API key, default base URL', () => {
    const m = languageModel(provider({ secret: { apiKey: 'sk-ant' } }), model('claude-sonnet-5'));
    expect(sdk.anthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant', baseURL: undefined });
    expect(m).toEqual({ sdk: 'anthropic', modelId: 'claude-sonnet-5' });
  });

  it('Anthropic: custom base URL for a gateway', () => {
    languageModel(provider({ baseUrl: 'https://gw.acme.example/anthropic/v1', secret: { apiKey: 'k' } }), model('x'));
    expect(sdk.anthropic).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'https://gw.acme.example/anthropic/v1' });
  });

  it('Bedrock: access keys, default region eu-central-1', () => {
    languageModel(provider({ type: 'bedrock', secret: { accessKeyId: 'AKIA', secretAccessKey: 's3cr3t' } }), model('eu.anthropic.claude-haiku-4-5-20251001-v1:0'));
    expect(sdk.bedrock).toHaveBeenCalledWith({
      region: 'eu-central-1', accessKeyId: 'AKIA', secretAccessKey: 's3cr3t', sessionToken: undefined, baseURL: undefined,
    });
  });

  it('Bedrock: API key, own region and VPC endpoint', () => {
    languageModel(provider({ type: 'bedrock', region: 'eu-west-1', baseUrl: 'https://vpce.example', secret: { apiKey: 'bedrock-key' } }), model('x'));
    expect(sdk.bedrock).toHaveBeenCalledWith({ region: 'eu-west-1', apiKey: 'bedrock-key', baseURL: 'https://vpce.example' });
  });

  it('Bedrock: IAM role without stored secret uses self-renewing short-term keys', () => {
    languageModel(provider({ type: 'bedrock', options: { auth: 'iam' } }), model('eu.anthropic.claude-haiku-4-5-20251001-v1:0'));
    expect(sdk.bedrock).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-central-1', apiKey: expect.any(String), fetch: expect.any(Function) }));
  });

  it('GitHub: default inference endpoint', () => {
    languageModel(provider({ type: 'github', secret: { apiKey: 'ghp' } }), model('openai/gpt-4.1'));
    expect(sdk.compat).toHaveBeenCalledWith({ name: 'github', baseURL: 'https://models.github.ai/inference', apiKey: 'ghp' });
  });

  it('GitHub: organization endpoint', () => {
    languageModel(provider({ type: 'github', options: { org: 'acme' }, secret: { apiKey: 'ghp' } }), model('openai/gpt-4.1'));
    expect(sdk.compat).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://models.github.ai/orgs/acme/inference' }));
  });

  it('GitHub: explicit base URL wins over the organization', () => {
    languageModel(provider({ type: 'github', options: { org: 'acme' }, baseUrl: 'https://models.acme.ghe.com/inference' }), model('x'));
    expect(sdk.compat).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://models.acme.ghe.com/inference', apiKey: undefined }));
  });

  it('OpenAI-compatible: base URL and optional key', () => {
    languageModel(provider({ type: 'openai_compatible', baseUrl: 'http://ollama:11434/v1' }), model('qwen3:32b'));
    expect(sdk.compat).toHaveBeenCalledWith({ name: 'custom', baseURL: 'http://ollama:11434/v1', apiKey: undefined });
  });

  it('OpenAI-compatible: base URL is required', () => {
    expect(() => languageModel(provider({ type: 'openai_compatible' }), model('x'))).toThrow(/baseUrl required/);
  });
});

describe('MODEL_PRESETS', () => {
  it('has presets for every provider type except OpenAI-compatible', () => {
    for (const type of ['anthropic', 'bedrock', 'github'] as const) expect(MODEL_PRESETS[type].length).toBeGreaterThan(0);
    expect(MODEL_PRESETS.openai_compatible).toEqual([]);
  });

  it('uses EU inference profiles for Bedrock', () => {
    for (const p of MODEL_PRESETS.bedrock) expect(p.modelId).toMatch(/^eu\./);
  });

  it('has unique model IDs per provider type', () => {
    for (const list of Object.values(MODEL_PRESETS)) expect(new Set(list.map((p) => p.modelId)).size).toBe(list.length);
  });
});
