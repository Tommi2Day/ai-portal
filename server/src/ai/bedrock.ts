/**
 * AWS Bedrock: authentication and the model list of the AWS account.
 *
 * Authentication modes (provider option `auth`):
 *   keys   – static access keys stored (encrypted) in the provider, SigV4
 *   apiKey – static Bedrock API key stored in the provider, Bearer
 *   iam    – no stored secret: AWS default credential chain of the process (EKS Pod Identity, IRSA,
 *            instance profile, AWS_* variables), optionally assuming `roleArn`. Requests use short-term
 *            Bedrock API keys that are signed locally from these credentials and renewed before they expire.
 */
import { BedrockClient, GetFoundationModelAvailabilityCommand, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { getToken } from '@aws/bedrock-token-generator';
import { config } from '../config.js';
import { decryptJson } from '../crypto.js';
import type { Provider } from '../db/schema.js';

export type BedrockAuth = 'keys' | 'apiKey' | 'iam';
type FetchFunction = typeof globalThis.fetch;
type AwsCredentialIdentityProvider = ReturnType<typeof fromNodeProviderChain>;
type AwsCredentialIdentity = Awaited<ReturnType<AwsCredentialIdentityProvider>>;

interface BedrockSecret { apiKey?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }

export const DEFAULT_REGION = 'eu-central-1';
export const regionOf = (p: Provider) => p.region || DEFAULT_REGION;

/** Explicit option wins; older providers without the option are derived from the stored secret. */
export function bedrockAuth(p: Provider, s = decryptJson<BedrockSecret>(p.secretEnc, {})): BedrockAuth {
  const o = p.options?.auth;
  if (o === 'keys' || o === 'apiKey' || o === 'iam') return o;
  if (s.apiKey) return 'apiKey';
  if (s.accessKeyId) return 'keys';
  return 'iam';
}

/* ---------------- Credentials (keys / iam, optional assume role) ---------------- */

const credCache = new Map<string, AwsCredentialIdentityProvider>();

/** Credential provider for SigV4 calls (control plane, token signing). Cached per configuration. */
export function bedrockCredentials(p: Provider): AwsCredentialIdentityProvider {
  const s = decryptJson<BedrockSecret>(p.secretEnc, {});
  const auth = bedrockAuth(p, s);
  if (auth === 'apiKey') throw new Error('Mit einem Bedrock-API-Key ist nur der Modellaufruf möglich');
  const roleArn = p.options?.roleArn || undefined;
  const externalId = p.options?.externalId || undefined;
  const key = JSON.stringify([p.id, auth, regionOf(p), roleArn, externalId, auth === 'keys' ? p.secretEnc : null]);
  let provider = credCache.get(key);
  if (!provider) {
    const base: AwsCredentialIdentityProvider = auth === 'keys'
      ? async () => ({ accessKeyId: s.accessKeyId ?? '', secretAccessKey: s.secretAccessKey ?? '', sessionToken: s.sessionToken || undefined })
      : fromNodeProviderChain();
    provider = roleArn
      ? fromTemporaryCredentials({
        masterCredentials: base,
        params: { RoleArn: roleArn, RoleSessionName: 'ai-portal', ExternalId: externalId, DurationSeconds: 3600 },
        clientConfig: { region: regionOf(p) },
      })
      : base;
    credCache.set(key, provider);
  }
  return provider;
}

/* ---------------- Short-term API keys (iam) ---------------- */

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();
/** Renew when less than this is left (or a fifth of the lifetime for short TTLs). */
const RENEW_BEFORE_MS = 5 * 60_000;

const tokenKey = (p: Provider) => JSON.stringify([p.id, regionOf(p), p.options?.roleArn ?? '', p.options?.externalId ?? '']);

/**
 * Short-term Bedrock API key for the provider. Signed locally (no AWS request) from the current credentials;
 * valid for min(BEDROCK_TOKEN_TTL_SECONDS, credential expiry). Cached until shortly before it expires.
 */
export async function shortTermApiKey(p: Provider, now = Date.now()): Promise<string> {
  const key = tokenKey(p);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now > Math.min(RENEW_BEFORE_MS, (config.BEDROCK_TOKEN_TTL_SECONDS * 1000) / 5)) return cached.token;
  const creds: AwsCredentialIdentity = await bedrockCredentials(p)();
  const ttlMs = config.BEDROCK_TOKEN_TTL_SECONDS * 1000;
  const expiresAt = Math.min(now + ttlMs, creds.expiration ? creds.expiration.getTime() : Infinity);
  const token = await getToken({ credentials: creds, region: regionOf(p), expiresInSeconds: Math.max(60, Math.floor((expiresAt - now) / 1000)) });
  tokenCache.set(key, { token, expiresAt });
  return token;
}

export function forgetShortTermApiKey(p: Provider) {
  tokenCache.delete(tokenKey(p));
}

/**
 * fetch for the AI SDK in iam mode: replaces the Authorization header with the current short-term key.
 * A 401/403 with a cached key renews it once (e.g. credentials revoked or rotated early).
 */
export function shortTermKeyFetch(p: Provider, inner: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const send = async () => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${await shortTermApiKey(p)}`);
      return inner(input, { ...init, headers });
    };
    const res = await send();
    if (res.status !== 401 && res.status !== 403) return res;
    forgetShortTermApiKey(p);
    return send();
  };
}

/** Options for createAmazonBedrock (chat and embeddings). */
export function bedrockSdkOptions(p: Provider) {
  const s = decryptJson<BedrockSecret>(p.secretEnc, {});
  const common = { region: regionOf(p), baseURL: p.baseUrl || undefined };
  switch (bedrockAuth(p, s)) {
    case 'apiKey':
      return { ...common, apiKey: s.apiKey };
    case 'keys':
      return { ...common, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken || undefined };
    case 'iam':
      // The SDK only uses Bearer auth when an apiKey is set; the fetch wrapper replaces it on every request.
      return { ...common, apiKey: 'short-term-key', fetch: shortTermKeyFetch(p) };
  }
}

/* ---------------- Models available in the account ---------------- */

export interface AvailableModel {
  modelId: string;
  displayName: string;
  kind: 'chat' | 'embedding';
  supportsImages: boolean;
  /** inference profile (cross-region) or foundation model called in the region */
  via: 'profile' | 'region';
  /** model access in the account: granted, not granted, or unknown (no permission to check) */
  access: 'granted' | 'missing' | 'unknown';
  legacy: boolean;
}

interface Fm {
  modelId?: string; modelName?: string; providerName?: string; inputModalities?: string[]; outputModalities?: string[];
  inferenceTypesSupported?: string[]; responseStreamingSupported?: boolean; modelLifecycle?: { status?: string };
}

const listCache = new Map<string, { at: number; models: AvailableModel[] }>();
const LIST_TTL_MS = 10 * 60_000;

const prefixes = () => config.BEDROCK_INFERENCE_PROFILE_PREFIXES.split(',').map((x) => x.trim()).filter(Boolean);
export const profileAllowed = (id: string) => { const ps = prefixes(); return ps.length === 0 || ps.some((x) => id.startsWith(x)); };

async function paged<T>(fetchPage: (token?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do { const r = await fetchPage(token); out.push(...r.items); token = r.next; } while (token);
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * Chat models (inference profiles + on-demand foundation models) and embedding models of the account in the
 * provider's region, with the model access status. Needs bedrock:ListInferenceProfiles, bedrock:ListFoundationModels
 * and (for the access status) bedrock:GetFoundationModelAvailability. Cached for 10 minutes.
 */
export async function listAvailableModels(p: Provider, opts: { refresh?: boolean; client?: BedrockClient } = {}): Promise<AvailableModel[]> {
  const key = JSON.stringify([p.id, regionOf(p), p.options?.roleArn ?? '', p.secretEnc]);
  const hit = listCache.get(key);
  if (hit && !opts.refresh && Date.now() - hit.at < LIST_TTL_MS) return hit.models;

  const client = opts.client ?? new BedrockClient({ region: regionOf(p), credentials: bedrockCredentials(p) });
  const [fms, profiles] = await Promise.all([
    client.send(new ListFoundationModelsCommand({})).then((r) => (r.modelSummaries ?? []) as Fm[]),
    paged(async (nextToken) => {
      const r = await client.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken }));
      return { items: r.inferenceProfileSummaries ?? [], next: r.nextToken };
    }),
  ]);
  const fmById = new Map(fms.filter((m) => m.modelId).map((m) => [m.modelId!, m]));
  const isText = (m?: Fm) => !!m?.outputModalities?.includes('TEXT');
  const hasImages = (m?: Fm) => !!m?.inputModalities?.includes('IMAGE');
  const legacy = (m?: Fm) => m?.modelLifecycle?.status === 'LEGACY';

  const candidates: (Omit<AvailableModel, 'access'> & { fm: string })[] = [];
  for (const prof of profiles) {
    const id = prof.inferenceProfileId;
    if (!id || prof.status !== 'ACTIVE' || !profileAllowed(id)) continue;
    // arn:aws:bedrock:<region>::foundation-model/<model id>
    const fmId = prof.models?.[0]?.modelArn?.split('/').pop() ?? '';
    const fm = fmById.get(fmId);
    if (fm && !isText(fm)) continue;
    candidates.push({ modelId: id, displayName: prof.inferenceProfileName ?? id, kind: 'chat', supportsImages: hasImages(fm), via: 'profile', legacy: legacy(fm), fm: fmId });
  }
  for (const m of fms) {
    if (!m.modelId || !m.inferenceTypesSupported?.includes('ON_DEMAND')) continue;
    const name = [m.providerName, m.modelName].filter(Boolean).join(' ') || m.modelId;
    if (m.outputModalities?.includes('EMBEDDING')) {
      candidates.push({ modelId: m.modelId, displayName: name, kind: 'embedding', supportsImages: false, via: 'region', legacy: legacy(m), fm: m.modelId });
    } else if (isText(m) && m.responseStreamingSupported !== false) {
      candidates.push({ modelId: m.modelId, displayName: name, kind: 'chat', supportsImages: hasImages(m), via: 'region', legacy: legacy(m), fm: m.modelId });
    }
  }

  // Model access per foundation model; stop asking after the first AccessDenied (permission not granted).
  let canCheck = true;
  const access = new Map<string, AvailableModel['access']>();
  const fmIds = [...new Set(candidates.map((c) => c.fm).filter(Boolean))];
  await mapLimit(fmIds, 5, async (id) => {
    if (!canCheck) return;
    try {
      const r = await client.send(new GetFoundationModelAvailabilityCommand({ modelId: id }));
      const ok = r.authorizationStatus === 'AUTHORIZED' && r.entitlementAvailability === 'AVAILABLE'
        && r.agreementAvailability?.status !== 'NOT_AVAILABLE' && r.agreementAvailability?.status !== 'ERROR';
      access.set(id, ok ? 'granted' : 'missing');
    } catch (e) {
      if ((e as { name?: string }).name === 'AccessDeniedException') canCheck = false;
    }
  });

  const models = candidates
    .map(({ fm, ...c }) => ({ ...c, access: access.get(fm) ?? 'unknown' }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.via.localeCompare(b.via) || a.displayName.localeCompare(b.displayName));
  listCache.set(key, { at: Date.now(), models });
  return models;
}
