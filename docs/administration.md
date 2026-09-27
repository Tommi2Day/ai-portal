# Administration guide

Everything in this guide is done in the web UI under **Administration** (visible to admins only). Labels refer to the English UI; switch the language with **DE | EN** in the top bar.

## Users, roles and groups

**Tab “Users”**

- **Local users** are created here (username, display name, password ≥ 12 characters, role). Passwords can be reset via “Password”.
- **LDAP and SSO users** are created automatically on their first sign-in. Their display name, email and groups are refreshed on every sign-in.
- **Roles:** *Admin* sees the administration area; *Users* use chat, MCP servers and the knowledge base. If an admin group (LDAP) or admin role value (OIDC) is configured, the role is synced from the directory on every sign-in and manual changes are overwritten.
- **Groups** decide which knowledge collections a user can search. For local users, edit them via “change”; for LDAP/SSO users they come from the directory.
- **Deactivating** a user (“Active” unchecked) takes effect immediately — including personal access tokens.
- You cannot demote, deactivate or delete your own account.

## AI providers and models

Details per provider type (IAM policy, base URLs, proxy, what is sent, troubleshooting): [Connecting LLM providers](llm-providers.md).

**Tab “Providers & models”**

1. **Add a provider** (“Add provider”):

   | Type | What to enter |
   | --- | --- |
   | Anthropic Claude | API key; optional base URL for a proxy or gateway |
   | AWS Bedrock | Region, access key ID + secret access key **or** a Bedrock API key |
   | GitHub Models / Enterprise | Token with `models:read`; optional organization (bills and applies policies to the org) |
   | OpenAI-compatible | Base URL (Azure OpenAI, vLLM, Ollama, LiteLLM, TEI, …) and API key |

   Keys are write-only. “Key” replaces a key; the old one is never shown.

2. **Approve models** (“Approve model”): pick the provider, optionally a preset, set model ID and display name, and tick “understands images” if the model accepts images. Presets are starting points — verify model IDs against the vendor's current catalog.
3. Mark exactly one model as **default**. Disable models or whole providers to remove them from the user selection immediately.

## Knowledge base

**Tab “Knowledge base”**

### 1. Embedding model

Choose the provider and model that turns text into vectors. Options:

| Choice | When |
| --- | --- |
| Local model via an OpenAI-compatible provider (e.g. BGE-M3 on Ollama or Text Embeddings Inference) | Documents must not leave the company; good multilingual quality |
| Amazon Titan Text Embeddings v2 or Cohere Embed Multilingual (Bedrock) | Bedrock is already in use |
| `text-embedding-3-small` via GitHub Models or OpenAI-compatible | Quick start |

Anthropic does not offer embedding models. “Save & test” probes the model. **Changing the model re-indexes every source automatically**; stored text is re-embedded, nothing is downloaded again.

### 2. Collections

A collection groups sources and defines who can search them:

- **for all signed-in users**,
- **for groups** — comma-separated group names (LDAP CN, OIDC claim values, or groups of local users; case-insensitive),
- **admins only** — no groups and not public.

Write a short description: the model sees it and uses it to decide where to search. Permissions apply per collection, not per document — put only content with the same audience into one collection.

### 3. Sources

| Source | Setup |
| --- | --- |
| Upload (“Upload files”) | Upload files directly into the collection. Only the extracted text is kept; the original is discarded. |
| File share | Path below the mount root (see [installation](installation.md#file-shares-for-the-knowledge-base)), optional link prefix so hits link to the file (e.g. `file://fileserver/it/` or an intranet URL), optional exclusions (`Archive, Drafts`) |
| Confluence Cloud | Base URL `https://<site>.atlassian.net/wiki`, space keys, service account email + API token |
| Confluence Server / Data Center | Base URL, space keys, personal access token |
| SharePoint / OneDrive | Tenant ID, app (client) ID, client secret, and either a site URL (`https://<tenant>.sharepoint.com/sites/IT`) or a user's UPN for OneDrive; optional library name and sub folder |

**SharePoint app registration:** create an Entra ID app with the **application** permission `Sites.Selected` (recommended, then grant read access to the specific sites) or `Sites.Read.All` / `Files.Read.All`, grant admin consent, create a client secret.

**Sync:** each source has an interval (15 min, hourly, daily, manual). “Sync now” starts a run immediately. The result column shows `+added ~updated =unchanged −removed ✕errors`. “Documents” lists indexed documents with status and errors; single documents can be removed.

**What gets indexed:** PDF (with a text layer), DOCX, PPTX, XLSX, HTML, Markdown, text, CSV/JSON/YAML/XML and source code. Scanned PDFs without text, images and other binaries are skipped with a note. Only text is stored — hits link to the original in the source system; uploads link to a text version.

## Audit log

**Tab “Audit log”**

Filter by user, action prefix (e.g. `auth.`, `chat.`, `knowledge.`) and time range. “CSV export” downloads the filtered entries (up to 100,000 rows); the export itself is audited. Failed actions are highlighted. See [security & audit](security.md#audit-events) for the list of events.

## Routine tasks

| Task | How |
| --- | --- |
| Rotate a provider key | “Key” on the provider row |
| Offboard a user | Deactivate (keeps history) or delete (removes chats, files, MCP servers and tokens) |
| Investigate an incident | Audit log filtered by user and time range; stdout logs in your log stack |
| Check knowledge freshness | Status and last run per source; failed runs are audited as `knowledge.sync` with `success = false` |
