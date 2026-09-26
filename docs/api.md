# API & MCP reference

The web UI uses the same REST API that is described here. All endpoints are under `/api`, exchange JSON and authenticate with the session cookie `ap_session` (set by `POST /api/auth/login` or the OIDC flow).

**CSRF:** every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must send the header `X-Requested-With: ai-portal`, otherwise it fails with `403 {"error":"csrf"}`.

**Errors:** `{"error": "<message>"}` with a matching status code; validation errors (400) may add `issues`.

**Language:** messages are returned in German or English. The server uses the header `X-UI-Lang: de|en` (sent by the web UI), then the `ap_lang` cookie, then `Accept-Language`. Audit entries are always written in English, whatever the UI language.

## Authentication

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/auth/config` | Enabled sign-in methods: `{local, ldap, oidc: {name} \| null}` |
| POST | `/api/auth/login` | `{username, password, method: "local" \| "ldap"}` → sets cookie. Rate-limited to 20 attempts / 15 min / IP |
| GET | `/api/auth/oidc/start` | Redirects to the identity provider |
| GET | `/api/auth/oidc/callback` | Redirect target of the identity provider |
| GET | `/api/auth/me` | Current user `{id, username, displayName, email, role, authSource, groups}` |
| POST | `/api/auth/logout` | Ends the session |

## Chat

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/models` | Approved models `[{id, displayName, description, provider, supportsImages, isDefault}]` |
| GET | `/api/chats` | Own chats (latest 200) |
| POST | `/api/chats` | New chat `{modelId?}` |
| GET | `/api/chats/:id` | Chat with messages and attachment metadata |
| PATCH | `/api/chats/:id` | Rename `{title}` |
| DELETE | `/api/chats/:id` | Delete |
| POST | `/api/chats/:id/messages` | Send a message and stream the answer (see below) |
| POST | `/api/files` | Upload attachments (multipart, field `files`, up to 10) |
| GET | `/api/files/:id` | Download an own attachment |

### Streaming format

`POST /api/chats/:id/messages` with

```json
{ "content": "…", "modelId": "<uuid>", "attachmentIds": ["<uuid>"], "useMcp": true, "useKnowledge": true }
```

responds with `Content-Type: application/x-ndjson` — one JSON object per line:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `mcp` | `status: [{name, ok, tools, error?}]` | Result of connecting to the user's MCP servers |
| `text` | `d` | Text delta |
| `tool-call` | `id, name, input` | The model calls a tool |
| `tool-result` | `id, output` | Tool result (JSON string, truncated at 20,000 characters) |
| `tool-error` | `id, error` | Tool failed |
| `error` | `message` | Model or provider error |
| `done` | `messageId, usage: {inputTokens, outputTokens}, title?` | End of the answer; `title` is set for the first message of a chat |

## User MCP servers and tokens

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/api/mcp-servers` | List / add `{name, url, transport: "streamable-http" \| "sse", headers?, enabled?}` |
| PATCH / DELETE | `/api/mcp-servers/:id` | Change / delete; `headers` is write-only |
| POST | `/api/mcp-servers/:id/test` | Connect and list tools |
| GET / POST | `/api/tokens` | List / create `{name, expiresInDays: 1–365}` → `{id, expiresAt, token}` (token shown once) |
| DELETE | `/api/tokens/:id` | Revoke |

## Knowledge base (users)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/knowledge/collections` | `{enabled, collections: [{id, name, description}]}` — only accessible collections |
| GET | `/api/knowledge/search?q=…` | Hybrid search across accessible collections (10 hits) |
| GET | `/api/knowledge/documents/:id/open` | Redirects to the source; for uploads returns the text version |

## Administration (admins only)

| Area | Endpoints |
| --- | --- |
| Users | `GET/POST /api/admin/users`, `PATCH/DELETE /api/admin/users/:id` (`role`, `active`, `displayName`, `password`, `groups`) |
| Providers | `GET/POST /api/admin/providers`, `PATCH/DELETE /api/admin/providers/:id` (`secret` is write-only), `GET /api/admin/model-presets` |
| Models | `GET/POST /api/admin/models`, `PATCH/DELETE /api/admin/models/:id` |
| Audit | `GET /api/admin/audit?user=&action=&from=&to=&limit=&offset=&format=json\|csv` |
| Embedding | `GET/PUT /api/admin/knowledge/embedding` `{providerId, modelId, dimensions?}` — PUT probes the model and starts re-indexing when it changed |
| Collections | `GET/POST /api/admin/knowledge/collections`, `PATCH/DELETE /api/admin/knowledge/collections/:id`, `POST /api/admin/knowledge/collections/:id/upload` (multipart `files`) |
| Sources | `POST /api/admin/knowledge/sources`, `PATCH/DELETE /api/admin/knowledge/sources/:id`, `POST …/:id/sync` (202, runs in background), `GET …/:id/documents` |
| Documents | `DELETE /api/admin/knowledge/documents/:id` |

Source `config` by type:

```jsonc
// filesystem
{ "path": "it-handbook", "recursive": true, "urlPrefix": "file://fileserver/it/", "exclude": ["Archive"] }
// confluence (secret: cloud {email, apiToken} | server {token})
{ "baseUrl": "https://example.atlassian.net/wiki", "deployment": "cloud", "spaceKeys": ["IT", "OPS"] }
// sharepoint (secret: {clientSecret})
{ "tenantId": "…", "clientId": "…", "siteUrl": "https://example.sharepoint.com/sites/IT", "driveName": "Documents", "folderPath": "Manuals" }
```

## MCP endpoint

| Property | Value |
| --- | --- |
| URL | `<PUBLIC_URL>/mcp` |
| Transport | Streamable HTTP, stateless (`POST` only; `GET` / `DELETE` return 405) |
| Authentication | `Authorization: Bearer ap_…` (personal access token). Session cookies are not accepted. |
| Rate limit | 120 requests per minute and IP |
| Server name | `ai-portal-knowledge` |

### Tools

| Tool | Input | Output |
| --- | --- | --- |
| `sammlungen_auflisten` | – | `{sammlungen: [{name, beschreibung, dokumente}]}` |
| `wissensdatenbank_suchen` | `query` (string), `sammlung?` (collection name), `anzahl?` (1–20, default 8) | Text with numbered hits plus `structuredContent.treffer: [{nr, titel, url, quelle, sammlung, dokument_id, auszug}]`; `quelle` is `Original` (link to the source) or `Textfassung` (text version) |
| `dokument_lesen` | `dokument_id` (UUID), `max_zeichen?` (1,000–200,000, default 50,000) | Title, source link and full text |

Permissions are those of the token owner at the time of the call.

### Client configuration

LibreChat (`librechat.yaml`) — every user stores their own token:

```yaml
mcpServers:
  ai-knowledge:
    type: streamable-http
    url: https://ai.example.com/mcp
    headers:
      Authorization: "Bearer {{AI_PORTAL_TOKEN}}"
    customUserVars:
      AI_PORTAL_TOKEN:
        title: "AI Portal access token"
        description: "Create it in the AI Portal under MCP servers → access tokens"
```

Claude Desktop (`claude_desktop_config.json`) via the `mcp-remote` adapter:

```json
{
  "mcpServers": {
    "ai-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://ai.example.com/mcp", "--header", "Authorization:Bearer ${TOKEN}"],
      "env": { "TOKEN": "ap_…" }
    }
  }
}
```

## Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (database reachable) |
