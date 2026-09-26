import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { decryptJson } from '../crypto.js';
import type { Model, Provider } from '../db/schema.js';

interface ProviderSecret {
  apiKey?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/** Templates shown in the admin UI: predefined model choices per provider type. */
export const MODEL_PRESETS: Record<Provider['type'], { modelId: string; displayName: string; supportsImages: boolean }[]> = {
  anthropic: [
    { modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', supportsImages: true },
    { modelId: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', supportsImages: true },
    { modelId: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', supportsImages: true },
  ],
  bedrock: [
    { modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', displayName: 'Claude Sonnet 4.5 (Bedrock EU)', supportsImages: true },
    { modelId: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Claude Haiku 4.5 (Bedrock EU)', supportsImages: true },
    { modelId: 'eu.amazon.nova-pro-v1:0', displayName: 'Amazon Nova Pro (EU)', supportsImages: true },
  ],
  github: [
    { modelId: 'openai/gpt-4.1', displayName: 'GPT-4.1 (GitHub)', supportsImages: true },
    { modelId: 'openai/gpt-4.1-mini', displayName: 'GPT-4.1 mini (GitHub)', supportsImages: true },
    { modelId: 'meta/llama-4-maverick-17b-128e-instruct-fp8', displayName: 'Llama 4 Maverick (GitHub)', supportsImages: true },
  ],
  openai_compatible: [],
};

export function languageModel(p: Provider, m: Model): LanguageModel {
  const s = decryptJson<ProviderSecret>(p.secretEnc, {});
  switch (p.type) {
    case 'anthropic':
      return createAnthropic({ apiKey: s.apiKey, baseURL: p.baseUrl || undefined })(m.modelId);
    case 'bedrock':
      // Without keys the AWS default chain is not used by this SDK version -> use static keys or an API key.
      return createAmazonBedrock({
        region: p.region || 'eu-central-1',
        apiKey: s.apiKey || undefined,
        accessKeyId: s.accessKeyId || undefined,
        secretAccessKey: s.secretAccessKey || undefined,
        sessionToken: s.sessionToken || undefined,
        baseURL: p.baseUrl || undefined,
      })(m.modelId);
    case 'github': {
      // GitHub Models (github.com or GHE.com). Org-scoped endpoint enables org billing & policies.
      const org = p.options?.org;
      const base = p.baseUrl || (org ? `https://models.github.ai/orgs/${org}/inference` : 'https://models.github.ai/inference');
      return createOpenAICompatible({ name: 'github', baseURL: base, apiKey: s.apiKey })(m.modelId);
    }
    case 'openai_compatible':
      if (!p.baseUrl) throw new Error('baseUrl required for openai_compatible');
      return createOpenAICompatible({ name: 'custom', baseURL: p.baseUrl, apiKey: s.apiKey })(m.modelId);
  }
}
