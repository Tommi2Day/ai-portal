import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GetFoundationModelAvailabilityCommand, ListFoundationModelsCommand, ListInferenceProfilesCommand, type BedrockClient,
} from '@aws-sdk/client-bedrock';

const aws = vi.hoisted(() => {
  const creds = { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: undefined as Date | undefined };
  const chain = vi.fn(async () => ({ ...creds }));
  return {
    creds,
    chain,
    fromNodeProviderChain: vi.fn(() => chain),
    fromTemporaryCredentials: vi.fn((_o: unknown) => chain),
    getToken: vi.fn(async (_o: { expiresInSeconds?: number }) => `bedrock-api-key-${aws.getToken.mock.calls.length}`),
  };
});
vi.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: aws.fromNodeProviderChain, fromTemporaryCredentials: aws.fromTemporaryCredentials }));
vi.mock('@aws/bedrock-token-generator', () => ({ getToken: aws.getToken }));

const b = await import('../src/ai/bedrock.js');
const { config } = await import('../src/config.js');
const { encryptJson } = await import('../src/crypto.js');
type Provider = Parameters<typeof b.bedrockAuth>[0];

let n = 0;
const provider = (p: Partial<Provider> & { secret?: object } = {}): Provider => {
  const { secret, ...rest } = p;
  return {
    id: `p${++n}`, name: 'Bedrock', type: 'bedrock', baseUrl: null, region: null, options: {}, enabled: true, createdAt: new Date(),
    secretEnc: secret ? encryptJson(secret) : null, ...rest,
  } as Provider;
};

beforeEach(() => {
  vi.clearAllMocks();
  aws.creds.expiration = undefined;
  config.BEDROCK_INFERENCE_PROFILE_PREFIXES = '';
});

describe('bedrockAuth', () => {
  it('uses the explicit option', () => {
    expect(b.bedrockAuth(provider({ options: { auth: 'iam' }, secret: { apiKey: 'k' } }))).toBe('iam');
  });
  it('derives the mode of older providers from the stored secret', () => {
    expect(b.bedrockAuth(provider({ secret: { apiKey: 'k' } }))).toBe('apiKey');
    expect(b.bedrockAuth(provider({ secret: { accessKeyId: 'AKIA', secretAccessKey: 's' } }))).toBe('keys');
    expect(b.bedrockAuth(provider())).toBe('iam');
  });
});

describe('bedrockSdkOptions', () => {
  it('static API key', () => {
    expect(b.bedrockSdkOptions(provider({ region: 'eu-west-1', secret: { apiKey: 'k' } }))).toEqual({ region: 'eu-west-1', baseURL: undefined, apiKey: 'k' });
  });
  it('static access keys, default region', () => {
    expect(b.bedrockSdkOptions(provider({ secret: { accessKeyId: 'AKIA', secretAccessKey: 's' } }))).toEqual({
      region: 'eu-central-1', baseURL: undefined, accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: undefined,
    });
  });
  it('IAM role: Bearer mode with a fetch that injects the short-term key', () => {
    const o = b.bedrockSdkOptions(provider({ baseUrl: 'https://vpce.example' })) as { apiKey: string; fetch: unknown; baseURL: string };
    expect(o.apiKey).toBeTruthy();
    expect(typeof o.fetch).toBe('function');
    expect(o.baseURL).toBe('https://vpce.example');
  });
});

describe('bedrockCredentials', () => {
  it('default credential chain without a role', async () => {
    await b.bedrockCredentials(provider())();
    expect(aws.fromNodeProviderChain).toHaveBeenCalled();
    expect(aws.fromTemporaryCredentials).not.toHaveBeenCalled();
  });
  it('assumes the configured role with external ID', () => {
    b.bedrockCredentials(provider({ region: 'eu-west-1', options: { roleArn: 'arn:aws:iam::123456789012:role/bedrock', externalId: 'x-1' } }));
    expect(aws.fromTemporaryCredentials).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ RoleArn: 'arn:aws:iam::123456789012:role/bedrock', ExternalId: 'x-1', RoleSessionName: 'ai-portal' }),
      clientConfig: { region: 'eu-west-1' },
    }));
  });
  it('is not available for a static API key', () => {
    expect(() => b.bedrockCredentials(provider({ secret: { apiKey: 'k' } }))).toThrow(/nur der Modellaufruf/);
  });
});

describe('shortTermApiKey', () => {
  it('signs a key, caches it and renews it shortly before it expires', async () => {
    const p = provider();
    const t0 = 1_000_000;
    const k1 = await b.shortTermApiKey(p, t0);
    expect(aws.getToken).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-central-1', expiresInSeconds: 3600 }));
    expect(await b.shortTermApiKey(p, t0 + 50 * 60_000)).toBe(k1);          // 10 min left: cached
    const k2 = await b.shortTermApiKey(p, t0 + 56 * 60_000);                 // 4 min left: renewed
    expect(k2).not.toBe(k1);
    expect(aws.getToken).toHaveBeenCalledTimes(2);
  });
  it('never outlives the underlying credentials', async () => {
    const t0 = 2_000_000;
    aws.creds.expiration = new Date(t0 + 15 * 60_000);
    await b.shortTermApiKey(provider(), t0);
    expect(aws.getToken).toHaveBeenCalledWith(expect.objectContaining({ expiresInSeconds: 900 }));
  });
});

describe('shortTermKeyFetch', () => {
  it('sets the current key as Bearer token', async () => {
    const inner = vi.fn(async (_i: unknown, _init?: RequestInit) => new Response('{}', { status: 200 }));
    await b.shortTermKeyFetch(provider(), inner as never)('https://bedrock', { headers: { authorization: 'Bearer placeholder', 'x-a': '1' } });
    const h = new Headers(inner.mock.calls[0][1]?.headers);
    expect(h.get('authorization')).toMatch(/^Bearer bedrock-api-key-/);
    expect(h.get('x-a')).toBe('1');
  });
  it('renews the key once after 403', async () => {
    const inner = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await b.shortTermKeyFetch(provider(), inner)('https://bedrock', {});
    expect(res.status).toBe(200);
    const auth = inner.mock.calls.map((c) => new Headers(c[1].headers).get('authorization'));
    expect(auth[0]).not.toBe(auth[1]);
  });
});

describe('listAvailableModels', () => {
  const fm = (modelId: string, o: object = {}) => ({
    modelId, modelName: modelId, providerName: 'X', inputModalities: ['TEXT'], outputModalities: ['TEXT'],
    inferenceTypesSupported: ['INFERENCE_PROFILE'], responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' }, ...o,
  });
  const profile = (id: string, fmId: string) => ({
    inferenceProfileId: id, inferenceProfileName: `Name ${id}`, status: 'ACTIVE',
    models: [{ modelArn: `arn:aws:bedrock:eu-central-1::foundation-model/${fmId}` }],
  });
  const fakeClient = (avail: (id: string) => object | Error) => ({
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListFoundationModelsCommand) {
        return { modelSummaries: [
          fm('anthropic.claude-sonnet', { inputModalities: ['TEXT', 'IMAGE'] }),
          fm('anthropic.claude-old', { modelLifecycle: { status: 'LEGACY' } }),
          fm('amazon.titan-embed-text-v2:0', { outputModalities: ['EMBEDDING'], inferenceTypesSupported: ['ON_DEMAND'] }),
          fm('mistral.small', { inferenceTypesSupported: ['ON_DEMAND'] }),
          fm('stability.image', { outputModalities: ['IMAGE'], inferenceTypesSupported: ['ON_DEMAND'] }),
        ] };
      }
      if (cmd instanceof ListInferenceProfilesCommand) {
        const next = (cmd as ListInferenceProfilesCommand).input.nextToken;
        return next
          ? { inferenceProfileSummaries: [profile('us.anthropic.claude-sonnet', 'anthropic.claude-sonnet')] }
          : { inferenceProfileSummaries: [profile('eu.anthropic.claude-sonnet', 'anthropic.claude-sonnet'), profile('eu.anthropic.claude-old', 'anthropic.claude-old')], nextToken: 'p2' };
      }
      if (cmd instanceof GetFoundationModelAvailabilityCommand) {
        const r = avail((cmd as GetFoundationModelAvailabilityCommand).input.modelId!);
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error('unexpected command');
    }),
  }) as unknown as BedrockClient;
  const granted = { authorizationStatus: 'AUTHORIZED', entitlementAvailability: 'AVAILABLE', agreementAvailability: { status: 'AVAILABLE' } };

  it('lists inference profiles (all pages), on-demand chat and embedding models with access status', async () => {
    const client = fakeClient((id) => (id === 'mistral.small' ? { ...granted, authorizationStatus: 'NOT_AUTHORIZED' } : granted));
    const ms = await b.listAvailableModels(provider(), { client });
    expect(ms.map((m) => [m.kind, m.via, m.modelId, m.access])).toEqual([
      ['chat', 'profile', 'eu.anthropic.claude-old', 'granted'],
      ['chat', 'profile', 'eu.anthropic.claude-sonnet', 'granted'],
      ['chat', 'profile', 'us.anthropic.claude-sonnet', 'granted'],
      ['chat', 'region', 'mistral.small', 'missing'],
      ['embedding', 'region', 'amazon.titan-embed-text-v2:0', 'granted'],
    ]);
    const sonnet = ms.find((m) => m.modelId === 'eu.anthropic.claude-sonnet')!;
    expect(sonnet).toMatchObject({ displayName: 'Name eu.anthropic.claude-sonnet', supportsImages: true, legacy: false });
    expect(ms.find((m) => m.modelId === 'eu.anthropic.claude-old')!.legacy).toBe(true);
  });

  it('keeps only the configured inference profile prefixes', async () => {
    config.BEDROCK_INFERENCE_PROFILE_PREFIXES = 'eu., global.';
    const ms = await b.listAvailableModels(provider(), { client: fakeClient(() => granted) });
    expect(ms.filter((m) => m.via === 'profile').map((m) => m.modelId)).toEqual(['eu.anthropic.claude-old', 'eu.anthropic.claude-sonnet']);
  });

  it('reports access as unknown without GetFoundationModelAvailability permission and caches the list', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const client = fakeClient(() => denied);
    const p = provider();
    const ms = await b.listAvailableModels(p, { client });
    expect(new Set(ms.map((m) => m.access))).toEqual(new Set(['unknown']));
    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls.length;
    await b.listAvailableModels(p, { client });
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    await b.listAvailableModels(p, { client, refresh: true });
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls);
  });
});
