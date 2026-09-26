# Security & audit

## Security model

| Area | Measure |
| --- | --- |
| Stored secrets | Provider keys, MCP headers and knowledge-source credentials are encrypted with AES-256-GCM (`ENCRYPTION_KEY`). They are write-only in the API and never returned to the browser. |
| Passwords | bcrypt, cost 12; minimum length 12 for local accounts; constant-time response for unknown users |
| Sessions | Signed JWT in an HttpOnly, SameSite=Lax cookie (`Secure` with `COOKIE_SECURE=true`). The user is reloaded from the database on every request, so deactivation and role changes apply immediately. |
| CSRF | State-changing requests require `X-Requested-With: ai-portal`; the API allows no cross-origin requests |
| Brute force | 20 sign-in attempts per 15 minutes and IP; 120 requests per minute and IP on `/mcp` |
| LDAP | Filter values escaped (RFC 4515); empty passwords rejected to prevent anonymous binds; certificate verification on by default |
| OIDC | Authorization code flow with PKCE, state and nonce; flow data in a signed, 10-minute cookie |
| Access tokens | Random 256-bit tokens with prefix `ap_`, stored as SHA-256 only, expiring (≤ 365 days), revocable, bound to an active user |
| Data separation | Chats, attachments, MCP servers and tokens are always filtered by the owner; knowledge collections by group; documents are opened only after a collection access check |
| SSRF | MCP URLs restricted to http(s); private ranges can be blocked (`MCP_ALLOW_PRIVATE_NETWORKS=false`); file-share paths confined to `KNOWLEDGE_FS_ROOT` |
| Browser | Helmet headers incl. Content-Security-Policy `default-src 'self'`; downloads with `nosniff` and `attachment` disposition |
| Container | Non-root, read-only root file system, all capabilities dropped, seccomp `RuntimeDefault` |
| Network | NetworkPolicy allows ingress only from the ingress controller; restrict egress to known targets in production |

**Knowledge base data handling:** only the extracted text of documents is stored; original files are discarded after extraction. Permissions are enforced per collection, not per document — collections should only contain content with the same audience.

**Recommended before production:** penetration test, virus scanning for uploads (e.g. ClamAV sidecar), egress restrictions, secret rotation procedure, retention jobs for chats and audit data.

## Audit events

Each event is written to the `audit_log` table and as a JSON line with `"audit": true` to stdout. Audit entries are always in English, regardless of the language selected in the UI (failure reasons and error messages are translated before they are stored); entries written by earlier versions are converted once on start. Every entry has: timestamp, user ID and name, action, target type and ID, success, client IP (from `X-Forwarded-For` behind the ingress), user agent and details.

| Action | Recorded when | Details |
| --- | --- | --- |
| `auth.login` / `auth.login_failed` / `auth.logout` | Sign-in and sign-out | Method, failure reason |
| `user.create` / `user.update` / `user.delete` | User management | Changed fields (never passwords) |
| `provider.*`, `model.*` | Provider and model changes | Changed fields; `secretChanged` instead of key values |
| `mcp.create` / `mcp.update` / `mcp.delete` / `mcp.test` | User MCP server changes | Name, URL, tool count |
| `mcp.tool_call` | Every MCP tool call in a chat | Server, tool, duration, error |
| `chat.create` / `chat.delete` | Chat lifecycle | Title |
| `chat.prompt` | Every message sent | Model, provider, character count, attachment count; full text only with `AUDIT_LOG_PROMPTS=true` |
| `chat.completion` / `chat.error` | Every answer | Model, duration, input/output tokens, tool calls, message IDs, error |
| `file.upload` / `file.download` | Chat attachments | File name, size, MIME type, SHA-256 |
| `knowledge.search` | Every knowledge search (chat, MCP, API) | Channel, collections, hit count, document IDs found; query text only with `AUDIT_LOG_PROMPTS=true` |
| `knowledge.document.read` / `knowledge.document.open` | Full document read via MCP / opened via link | Title |
| `knowledge.sync` | Every sync run | Source, trigger, statistics, duration, error |
| `knowledge.upload`, `knowledge.collection.*`, `knowledge.source.*`, `knowledge.document.delete`, `knowledge.settings` | Knowledge administration | Names, configuration (never secrets) |
| `token.create` / `token.delete` / `token.auth_failed` | Access tokens | Name, expiry, failure reason |
| `audit.export` | CSV export | Filter, row count |

**Retention:** the application deletes nothing automatically. Agree on retention periods and implement a scheduled cleanup (e.g. `DELETE FROM audit_log WHERE ts < now() - interval '12 months'`); keep long-term, immutable copies in the log stack.
