# Connecting LLM providers

How the portal talks to language models, what to enter for each provider type, which data leaves the portal, and how to run it behind a proxy. For the admin UI in short see the [administration guide](administration.md#ai-providers-and-models).

## How it works

```
Browser ──HTTPS──▶ ai-portal (Node.js) ──HTTPS──▶ provider API
  model ID only      Vercel AI SDK                Anthropic · Bedrock · GitHub Models · OpenAI-compatible
                     keys decrypted per request
```

- **Everything runs server-side.** The browser only sends the ID of an approved model; the server loads provider and model from PostgreSQL, decrypts the credentials (AES-256-GCM, `ENCRYPTION_KEY`) and calls the provider through the [Vercel AI SDK](https://ai-sdk.dev). Keys never reach the browser and are never returned by the API.
- **No environment variables, no restart.** Providers and models live in the database and are managed under **Administration → Providers & models**. The SDK client is created per request, so a new key, a disabled provider or a new model takes effect with the next message.
- **Two roles for a provider:** *chat models* (any provider type) and the *embedding model* of the knowledge base (Bedrock, GitHub Models or OpenAI-compatible — Anthropic has no embedding API).
- **Model catalog:** users only choose from models an admin approved. Disabling a model or its provider removes it from the selection immediately; existing chats stay readable.

## Provider types

| Type | SDK package | API called | Authentication |
| --- | --- | --- | --- |
| Anthropic Claude | `@ai-sdk/anthropic` | Messages API, `<base>/messages` (default base `https://api.anthropic.com/v1`) | API key (`x-api-key`) |
| AWS Bedrock | `@ai-sdk/amazon-bedrock` | Converse API, `https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse-stream` | Access key + secret (SigV4) **or** Bedrock API key (Bearer) |
| GitHub Models / Enterprise | `@ai-sdk/openai-compatible` | `https://models.github.ai/inference/chat/completions`, with organization `…/orgs/<org>/inference/…` | Token with `models:read` (Bearer) |
| OpenAI-compatible | `@ai-sdk/openai-compatible` | `<base URL>/chat/completions`, embeddings `<base URL>/embeddings` | API key (Bearer), optional |

### Anthropic Claude

| Field | Value |
| --- | --- |
| API key | From the [Anthropic Console](https://console.anthropic.com) → API keys. Use a dedicated key (and workspace) for the portal so spend limits and usage reports apply to it alone. |
| Base URL | Empty for the Anthropic API. Set it only for a gateway or proxy that speaks the Anthropic Messages API — the URL must include the version path, e.g. `https://llm-gateway.acme.example/anthropic/v1`. |

Presets: `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` — all understand images.

### AWS Bedrock

| Field | Value |
| --- | --- |
| Region | Region of the Bedrock runtime endpoint, e.g. `eu-central-1` (default when empty). |
| Access key ID + secret access key | IAM user dedicated to the portal (see policy below). Signed with SigV4. |
| *or* Bedrock API key | A long-term Bedrock API key; sent as Bearer token. Leave the access key fields empty. |

**Model IDs.** Current Anthropic models on Bedrock are called through a *cross-region inference profile*: the model ID starts with the geography, e.g. `eu.anthropic.claude-haiku-4-5-20251001-v1:0`. The profile keeps processing inside the EU regions. Presets: Claude Sonnet 4.5 and Haiku 4.5 (EU profiles), Amazon Nova Pro (EU).

**Model access.** Anthropic models require a one-time use-case form in the Bedrock console of the AWS account before the first call.

**IAM policy** (minimum for chat and Titan/Cohere embeddings):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:eu-central-1:<account-id>:inference-profile/eu.*"
    ]
  }]
}
```

With an inference profile the foundation-model permission must cover every region the profile routes to — hence `*` for the region above. Narrow the model part (`anthropic.claude-*`, `amazon.titan-embed-*`) as you like.

**No IAM roles (IRSA, Pod Identity, instance profiles).** The portal does not use the AWS default credential chain; it needs static keys or a Bedrock API key stored in the provider. A session token (temporary credentials) can only be set through the API (`PATCH /api/admin/providers/:id` with `secret.sessionToken`) and expires, so it is not suitable for continuous operation. Supporting the credential chain is an open decision in the architecture concept.

**Base URL** (API only): a VPC interface endpoint for `bedrock-runtime`, e.g. `https://vpce-….bedrock-runtime.eu-central-1.vpce.amazonaws.com`, when traffic must not leave the VPC. With private DNS enabled on the endpoint the default hostname already resolves to it and no base URL is needed.

### GitHub Models / GitHub Enterprise

| Field | Value |
| --- | --- |
| Token | Fine-grained personal access token with the permission **Models: read** (`models:read`), or a GitHub App token with the same permission. |
| Organization (optional) | Uses the org endpoint `https://models.github.ai/orgs/<org>/inference`: requests count against the organization, which applies its model policies and — if paid usage is enabled — its billing. The organization must have GitHub Models enabled. |
| Base URL (optional) | Only for a different inference endpoint (e.g. a GHE.com tenant); replaces the default and the organization URL. |

Model IDs have the form `<publisher>/<model>`, e.g. `openai/gpt-4.1`, `meta/llama-4-maverick-17b-128e-instruct-fp8`. The free tier has low rate limits — for regular use enable paid usage on the organization.

### OpenAI-compatible endpoints

Any server that implements `POST /chat/completions` (and for embeddings `POST /embeddings`) in the OpenAI format. The base URL is the part before `/chat/completions`; the API key is sent as `Authorization: Bearer <key>` and may stay empty for servers without authentication.

| Target | Base URL | Model ID | Notes |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | e.g. `gpt-4.1` | |
| Azure OpenAI / Azure AI Foundry | `https://<resource>.openai.azure.com/openai/v1` | **deployment name** | v1 API; resource key as API key |
| Mistral | `https://api.mistral.ai/v1` | e.g. `mistral-large-latest` | |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | e.g. `gemini-2.5-pro` | Gemini API key |
| Ollama (on-prem) | `http://ollama.acme.local:11434/v1` | e.g. `qwen3:32b`, `bge-m3` (embeddings) | No key needed |
| vLLM (on-prem) | `http://vllm.acme.local:8000/v1` | the served model name | For tools start vLLM with `--enable-auto-tool-choice --tool-call-parser <parser>` |
| Text Embeddings Inference | `http://tei.acme.local:8080/v1` | the loaded model, e.g. `BAAI/bge-m3` | Embeddings only |
| LiteLLM proxy | `http://litellm.acme.local:4000/v1` | the model name configured in LiteLLM | LiteLLM virtual key as API key — adds per-team budgets, rate limits, fallbacks and further vendors |

Model IDs in the catalog must match exactly what the endpoint expects.

## Approving models

1. **Approve model**: choose the provider, optionally a *preset* (fills model ID, display name and image support), adjust the model ID and display name.
2. **Understands images**: tick only if the model accepts image input. Only then are uploaded images sent as images; otherwise the model gets only the text of attachments.
3. The model picker shows **display name · provider name**, ordered by sort order (API only) and display name. Put important hints into the display name, e.g. `Qwen3 32B (on-prem, confidential data)`. The description field (API only) is not shown to users.
4. Mark exactly one model as **default** — it is preselected for new chats.

Presets are starting points; model IDs change at the vendors. Check them against the current catalog before approving.

There is no separate connection test for chat models: send a short message in a new chat. Errors are shown in the chat and recorded as `chat.error` in the audit log. The embedding model has **Save & test** in the knowledge-base tab.

## What is sent to the provider

For every message the portal sends one streaming request (the AI SDK retries failed requests twice):

| Part | Content |
| --- | --- |
| System prompt | Fixed portal prompt (role, date, answer style); knowledge-base instructions if the knowledge tool is active; a language hint when the UI is set to English |
| History | **All** previous messages of the chat, including the extracted text of earlier attachments |
| New message | Extracted text of the attachments (`<datei name="…">…</datei>`) before the question; images as image parts if the model understands images |
| Tools | Tool definitions (name, description, input schema) of the user's active MCP servers and, if available, the knowledge-base search |
| Tool results | In the tool loop: MCP tool results and knowledge-base hits (text passages), up to `MAX_TOOL_STEPS` (default 8) rounds |

Consequences:

- **Context size.** Long chats and large attachments are re-sent with every message; beyond the model's context window the provider rejects the request. Users should start a new chat for a new topic.
- **Tool calling.** Tools are sent whenever a user has active MCP servers or access to the knowledge base (and the switches under the input field are on). Models or endpoints without function calling (some local models, vLLM without a tool parser) then fail — say so in the display name (e.g. `… (no tools)`) and have users switch *MCP tools* / *Knowledge base* off.
- **Embeddings.** When indexing, every text chunk of every document goes to the embedding provider; every knowledge search sends the query. For documents that must not leave the company use a local embedding model (Ollama, TEI) as an OpenAI-compatible provider.
- **Data protection.** Which vendor may receive which data (and under which data-processing terms) is an organizational decision. With several providers, say it in the display name, e.g. "(EU)", "(on-prem, confidential data)".

The answer is streamed to the browser as it arrives. Text, tool calls and token usage are stored with the message; closing the browser tab aborts the provider request.

## Network, proxy and certificates

| Topic | What to do |
| --- | --- |
| Egress | The pods need HTTPS to the configured endpoints, e.g. `api.anthropic.com`, `bedrock-runtime.<region>.amazonaws.com`, `models.github.ai`, or your internal Ollama/vLLM/LiteLLM hosts. The Kubernetes `NetworkPolicy` only restricts ingress; add egress rules if required. |
| HTTP proxy | Node.js ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set. Set `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY=http://proxy.acme.local:3128` and `NO_PROXY` for internal targets (database, LDAP, internal model hosts, `.acme.local`). This applies to all outgoing HTTP calls made with `fetch` (AI providers, embeddings, MCP servers). |
| TLS inspection / internal CA | `NODE_EXTRA_CA_CERTS=/etc/ssl/custom/ca.pem` with the CA mounted into the container (Secret or ConfigMap). |
| Private networks | `MCP_ALLOW_PRIVATE_NETWORKS` affects only user MCP servers, not providers — admins may point providers at internal addresses. |

## Operations

| Task | How |
| --- | --- |
| Rotate a key | **Key** in the provider row stores a new API key; it applies to the next message. For Bedrock with access keys, **Key** replaces the access keys with a Bedrock API key — rotate access keys via `PATCH /api/admin/providers/:id` with `{"secret":{"accessKeyId":"…","secretAccessKey":"…"}}`. |
| Change base URL / region | Via `PATCH /api/admin/providers/:id` (`baseUrl`, `region`, `options.org`); the UI sets them only when creating a provider. Alternatively create a new provider and move the models. |
| Switch off a vendor | Untick **Active** at the provider: all its models disappear from the picker at once. |
| Delete a provider | Deletes its models as well; chats keep their messages. |
| Costs and usage | Every answer stores input and output tokens (shown under the answer, in `messages.usage` and in the `chat.completion` audit entry with model, provider and duration). Budgets and quotas per team: put a LiteLLM proxy in front. |
| Audit | `provider.create/update/delete` (with `secretChanged`, never the key), `model.*`, `chat.prompt`, `chat.completion`, `chat.error` — see [Security & audit](security.md). |

## Troubleshooting

| Symptom in the chat | Likely cause |
| --- | --- |
| `401` / `403`, "invalid x-api-key", "security token … invalid" | Wrong or expired key; for Bedrock missing IAM permission or model access not granted |
| `404`, "model not found", "The provided model identifier is invalid" | Model ID does not exist for this endpoint or region; Bedrock: inference profile prefix missing (`eu.`) |
| "does not support tools", "tool_choice" errors | Model/endpoint without function calling — switch off *MCP tools* and *Knowledge base* or use another model |
| "prompt is too long", context length exceeded | Chat history or attachments too large — start a new chat |
| `429` | Rate limit of the provider (GitHub free tier, Anthropic tier limits) |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | Egress blocked, proxy not configured (`NODE_USE_ENV_PROXY`), wrong base URL |
| `self-signed certificate`, `unable to get local issuer certificate` | TLS inspection or internal CA — set `NODE_EXTRA_CA_CERTS` |

Details are in the pod log (`LOG_LEVEL=debug` for more) and in the audit entry `chat.error`.
