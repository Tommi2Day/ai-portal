# Security & audit

## Security model

| Area | Measure |
| --- | --- |
| Stored secrets | Provider keys, MCP headers and knowledge-source credentials are encrypted with AES-256-GCM (`ENCRYPTION_KEY`). They are write-only in the API and never returned to the browser. |
| Secret masking | Secrets are masked wherever text leaves the process: **logs** (`src/redact.ts` is applied to every log record: fields named like `password`, `secret`, `apiKey`, `authorization`, `cookie`, `token`… are replaced, bearer/basic credentials, URL passwords, secret query parameters (`?token=`, `?api_key=`, `?code=`…), JWTs and common token formats are masked inside strings, errors are reduced to type, message, stack, code and status so request bodies, headers and response bodies of SDK errors never reach the log), the **audit log** (details are masked when written and when read or exported, which also covers older entries), **stored and displayed error texts** (MCP/sync/chat errors) and the **UI** (URLs of MCP servers and sources are shown with secret parameters masked, secret inputs are password fields, a new access token is hidden until you click *Show*, and the old browser `prompt()` dialogs for passwords and API keys are replaced by masked inputs). |
| Knowledge update trigger | The webhook token (`kt_…`, 256 bit) belongs to one source and can only start that source's update. Only its SHA-256 is stored, comparison is constant-time, it is shown once (masked until revealed in the UI, masked in logs and audit entries) and replaced or revoked by admins at any time. The endpoint accepts no cookies and needs no CSRF header; every failure is answered with the same 401 and audited; 60 requests per minute and IP. Updates of an already running or disabled source are refused, a failing source never loses its stored content |
| Admin notes | The comment column (users, providers, models, collections, sources, SSO assignments) is admin-only free text: user-facing endpoints select their columns explicitly and never return it, it has no effect on access, and changes are audited. Secrets do not belong in notes; only secret-looking patterns are masked in logs and audit entries |
| Passwords | bcrypt, cost 12; minimum length 12 for local accounts; constant-time response for unknown users |
| Sessions | Signed JWT in an HttpOnly, SameSite=Lax cookie (`Secure` with `COOKIE_SECURE=true`). The user is reloaded from the database on every request, so deactivation and role changes apply immediately. |
| CSRF | State-changing requests require `X-Requested-With: ai-portal`; the API allows no cross-origin requests |
| Brute force | 20 sign-in attempts per 15 minutes and IP; 120 requests per minute and IP on `/mcp` |
| Self-registration | Off by default (`REGISTRATION_ENABLED`). Public sign-up creates only inactive local accounts that an admin must approve; 10 registrations per hour and IP; same password rules as admin-created accounts |
| Contributed articles | Searchable only after admin approval (enforced in search, document open and the MCP read tool); max. 10 open submissions per user |
| LDAP | Filter values escaped (RFC 4515); empty passwords rejected to prevent anonymous binds; certificate verification on by default |
| OIDC | Authorization code flow with PKCE, state and nonce; flow data in a signed, 10-minute cookie. Optional allow list and admin assignments by group, e-mail or object ID (deny by default); unverified e-mails are never used for matching |
| OAuth on `/mcp` | Access tokens are validated locally (signature via JWKS, issuer, audience, expiry); only known, active OIDC users are accepted, with the same allow rules as sign-in; denials are audited as `token.auth_failed` |
| OAuth client credentials (MCP servers) | Client secrets are encrypted and write-only; the token endpoint passes the same SSRF check as MCP URLs and redirects are refused; tokens are cached in memory only |
| Access tokens | Random 256-bit tokens with prefix `ap_`, stored as SHA-256 only, expiring (≤ 365 days), revocable, bound to an active user |
| Data separation | Chats, attachments, MCP servers and tokens are always filtered by the owner; knowledge collections by group; documents are opened only after a collection access check |
| SSRF | MCP URLs restricted to http(s); private ranges can be blocked (`MCP_ALLOW_PRIVATE_NETWORKS=false`); file-share paths confined to `KNOWLEDGE_FS_ROOT`. Web-page sources are configured by admins only; the crawler stays on the host and path of its start URLs, follows redirects only inside that area, sends the configured header only there, and is bounded by depth, page count and file size |
| Browser | Helmet headers incl. Content-Security-Policy `default-src 'self'`; downloads with `nosniff` and `attachment` disposition |
| Container | Non-root, read-only root file system, all capabilities dropped, seccomp `RuntimeDefault` |
| Network | NetworkPolicy allows ingress only from the ingress controller; restrict egress to known targets in production |

**Knowledge base data handling:** only the extracted text of documents is stored; original files are discarded after extraction. Permissions are enforced per collection, not per document — collections should only contain content with the same audience. Author, data source and last-change time of a document are stored as metadata and shown only to users who may see the document.

## OAuth and SSO: what to know

How OAuth is used: **(1)** sign-in with OIDC (authorization code + PKCE, the portal is the client); **(2)** OAuth access tokens on `/mcp` (the portal is the resource server and validates tokens issued by your identity provider); **(3)** OAuth client credentials for per-user MCP servers (the portal is the client and fetches tokens for the servers). The portal never forwards an inbound token to another server (no token passthrough): calls to MCP servers use the user's own header or client credentials.

| Topic | Behaviour | What you should do |
| --- | --- | --- |
| Token validation on `/mcp` | Signature via the issuer's JWKS, **asymmetric algorithms only** (`HS*` and `none` are rejected), issuer, audience, expiry (30 s tolerance). Validated locally; the provider is not called per request | Use https for the issuer; keep access-token lifetimes short (minutes to an hour) |
| Audience | Defaults to `OIDC_CLIENT_ID`, which is also the audience of the ID tokens of the portal sign-in | Set a **dedicated `MCP_OAUTH_AUDIENCE`** (e.g. `api://<app-id>`) so ID tokens cannot be used as access tokens |
| Issuer binding | Users are matched by subject (`oid`, else `sub`) **without the issuer**; a subject is unique per issuer only | Allow exactly **one issuer** (`MCP_OAUTH_ALLOWED_ISSUERS` only for versions of the same tenant, e.g. Entra v1/v2); never allow multi-tenant or third-party issuers |
| Who gets in | Deny by default: the subject must belong to a known, active portal user who signed in via OIDC; `OIDC_USER_VALUE` / allow lists apply; `/mcp` never grants admin. Denials are audited (`token.auth_failed`) | Remove people from the allow list or deactivate them in the portal for immediate effect |
| Groups | Taken from the token only (as at sign-in); a group the provider no longer lists is not kept from the last sign-in. Without a groups claim a token has no groups (fail closed) | Make sure the access token carries the groups claim; Entra omits it above 200 groups (overage) – use app roles or a smaller group set |
| Admin by e-mail | `preferred_username`, `upn` and `email` are mutable attributes in many providers; e-mails marked unverified are never used | Assign admins by **object ID**; keep the issuer to your own tenant |
| Sessions | The portal session (12 h by default) outlives a removal at the identity provider | Deactivate the user in the portal (takes effect on the next request) |
| Revocation | Access tokens cannot be revoked before they expire (no token introspection) | Short token lifetimes; deactivate the user |
| Client credentials (MCP servers) | Secrets encrypted and write-only; tokens cached in memory under a hash key, at most 24 h; response limited to 64 KB; redirects refused; the token URL passes the SSRF check | With the default `MCP_ALLOW_PRIVATE_NETWORKS=true` any user can make the portal call internal addresses (also through token URLs): set `false` in shared environments. Limit what the client-credentials identity may do at the MCP server (read-only database user, scopes) – everything the user's chats call runs with it |
| Startup warnings | The log warns about an `http` issuer, a missing `MCP_OAUTH_AUDIENCE` and several allowed issuers | Treat `mcp oauth:` warnings as configuration errors |

Masking is pattern based: a secret without a recognisable name or format (for example a bare random string in a free-text field) cannot be detected, so do not put credentials into names, descriptions or URLs path segments. Prompts and answers are not logged unless `AUDIT_LOG_PROMPTS=true`.

Known limits: the SSRF check resolves the host once, the connection resolves it again (DNS rebinding); the crawler and Confluence/SharePoint sources are admin-configured and not checked at all.

**Recommended before production:** penetration test, virus scanning for uploads (e.g. ClamAV sidecar), egress restrictions, secret rotation procedure, retention jobs for chats and audit data.

## Audit events

Each event is written to the `audit_log` table and as a JSON line with `"audit": true` to stdout. Audit entries are always in English, regardless of the language selected in the UI (failure reasons and error messages are translated before they are stored); entries written by earlier versions are converted once on start. Every entry has: timestamp, user ID and name, action, target type and ID, success, client IP (from `X-Forwarded-For` behind the ingress), user agent and details.

| Action | Recorded when | Details |
| --- | --- | --- |
| `auth.login` / `auth.login_failed` / `auth.logout` | Sign-in and sign-out | Method, failure reason |
| `auth.register` / `auth.profile` | Self-registration; name and email confirmed after the first LDAP/SSO sign-in | – |
| `user.create` / `user.update` / `user.delete` | User management | Changed fields (never passwords) |
| `provider.*`, `model.*` | Provider and model changes | Changed fields; `secretChanged` instead of key values |
| `sso.assignments` | SSO access/admin assignments changed in the admin UI | Count, entries |
| `mcp.create` / `mcp.update` / `mcp.delete` / `mcp.test` | User MCP server changes | Name, URL, tool count |
| `mcp.tool_call` | Every MCP tool call in a chat | Server, tool, duration, error |
| `plugin.update` | Admin enables or disables a deployed plugin | New state |
| `plugin.tool_call` | Every plugin tool call in a chat | Tool, duration, error |
| `chat.create` / `chat.delete` | Chat lifecycle | Title |
| `chat.prompt` | Every message sent | Model, provider, character count, attachment count; full text only with `AUDIT_LOG_PROMPTS=true` |
| `chat.completion` / `chat.error` | Every answer | Model, duration, input/output tokens, tool calls, message IDs, error |
| `file.upload` / `file.download` | Chat attachments | File name, size, MIME type, SHA-256 |
| `knowledge.search` | Every knowledge search (chat, MCP, API) | Channel, collections, hit count, document IDs found; query text only with `AUDIT_LOG_PROMPTS=true` |
| `knowledge.document.read` / `knowledge.document.open` | Full document read via MCP / opened via link | Title |
| `knowledge.sync` | Every sync run | Source, trigger (`schedule`, `manual`, `external`), replace, statistics, duration, error |
| `knowledge.source.trigger_token` | External trigger token created or revoked | Source, `created` / `revoked` (never the token) |
| `knowledge.trigger_failed` | Webhook call with a missing, malformed or wrong token | Reason, source ID; IP and user agent in the audit columns |
| `knowledge.article.submit` / `.approve` / `.reject` | Contributed articles | Title, collection, document ID |
| `knowledge.upload`, `knowledge.collection.*`, `knowledge.source.*`, `knowledge.document.delete`, `knowledge.settings` | Knowledge administration | Names, configuration (never secrets) |
| `token.create` / `token.delete` / `token.auth_failed` | Access tokens | Name, expiry, failure reason |
| `audit.export` | CSV export | Filter, row count |

**Retention:** the application deletes nothing automatically. Agree on retention periods and implement a scheduled cleanup (e.g. `DELETE FROM audit_log WHERE ts < now() - interval '12 months'`); keep long-term, immutable copies in the log stack.
