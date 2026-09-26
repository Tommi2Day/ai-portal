# Configuration reference

All settings are environment variables, validated on start (the process exits with a clear message if a required value is missing or invalid). Booleans accept `true` / `false`. In Kubernetes, put secrets into the Secret and everything else into the ConfigMap.

Provider credentials, AI models, knowledge collections and sources are **not** environment variables — admins manage them in the UI and they are stored encrypted in the database.

## Core

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `PUBLIC_URL` | `http://localhost:8080` | External base URL. Used for the OIDC redirect URI and absolute links in MCP results. |
| `DATABASE_URL` | `postgres://aiportal:aiportal@localhost:5432/aiportal` | PostgreSQL connection string (pgvector required) |
| `SESSION_SECRET` | – (required) | ≥ 32 characters; signs session and OIDC flow cookies |
| `ENCRYPTION_KEY` | – (required) | 32 bytes, base64; AES-256-GCM key for stored credentials |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `COOKIE_SECURE` | `false` | Set `true` whenever the portal is served over HTTPS |
| `STATIC_DIR` | `../web/dist` | Directory of the built web UI (`/app/web` in the image) |
| `LOG_LEVEL` | `info` | pino log level (`debug`, `info`, `warn`, `error`) |

## Bootstrap and local sign-in

| Variable | Default | Description |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_USER` | `admin` | Username of the first admin |
| `BOOTSTRAP_ADMIN_PASSWORD` | – | If set and the user table is empty, a local admin is created on start |
| `AUTH_LOCAL_ENABLED` | `true` | Allow sign-in with local accounts |

## LDAP / Active Directory

| Variable | Default | Description |
| --- | --- | --- |
| `LDAP_ENABLED` | `false` | Enable LDAP sign-in |
| `LDAP_URL` | – | `ldaps://dc01.example.local:636` (recommended) or `ldap://…` |
| `LDAP_BIND_DN` | – | Service account used to search for users |
| `LDAP_BIND_PASSWORD` | – | Password of the service account (secret) |
| `LDAP_SEARCH_BASE` | – | Base DN for the user search |
| `LDAP_SEARCH_FILTER` | `(uid={{username}})` | `{{username}}` is replaced (escaped). Active Directory: `(sAMAccountName={{username}})` |
| `LDAP_ATTR_DISPLAYNAME` | `displayName` | Attribute for the display name |
| `LDAP_ATTR_EMAIL` | `mail` | Attribute for the email address |
| `LDAP_USER_GROUP_DN` | – | If set, only members of this group may sign in |
| `LDAP_ADMIN_GROUP_DN` | – | Members of this group become admins (synced on every sign-in) |
| `LDAP_GROUP_SEARCH_BASE` | – | Where to search for groups (`member`/`uniqueMember`) if the user entry has no `memberOf` |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the `ldaps://` certificate. Only disable for tests. |

Group names are stored as the CN (`CN=IT-Team,OU=…` → `IT-Team`) and used for knowledge-base access. Nested AD groups are not resolved.

## OIDC (Azure AD / Entra ID, Keycloak, …)

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_ENABLED` | `false` | Enable SSO |
| `OIDC_ISSUER` | – | Azure: `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `OIDC_CLIENT_ID` | – | Application (client) ID |
| `OIDC_CLIENT_SECRET` | – | Client secret (secret) |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes |
| `OIDC_DISPLAY_NAME` | `Microsoft` | Label on the sign-in button |
| `OIDC_ROLE_CLAIM` | `roles` | Claim that carries roles (Azure app roles) |
| `OIDC_USER_VALUE` | – | If set, this value must be present in the role claim to sign in (e.g. `AiPortal.User`) |
| `OIDC_ADMIN_VALUE` | – | Value that grants the admin role (e.g. `AiPortal.Admin`) |
| `OIDC_GROUP_CLAIM` | `groups` | Claim with group names for knowledge-base access (role claim values are added too) |

Redirect URI to register at the identity provider: `<PUBLIC_URL>/api/auth/oidc/callback`. Azure returns group **object IDs** in the `groups` claim unless configured otherwise; using app roles or configuring group names ("sAMAccountName" in the token configuration) is easier to maintain.

## Chat, uploads and MCP

| Variable | Default | Description |
| --- | --- | --- |
| `UPLOAD_MAX_MB` | `20` | Maximum size per chat attachment |
| `MAX_TOOL_STEPS` | `8` | Maximum model ↔ tool round trips per answer |
| `MCP_ALLOW_PRIVATE_NETWORKS` | `true` | Allow user MCP servers on private IP ranges. Set `false` to block them (SSRF protection). |

## Knowledge base

| Variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_ENABLED` | `true` | Enable the knowledge base, its admin UI and the `/mcp` endpoint |
| `KNOWLEDGE_WORKER` | `true` | Run the sync scheduler in this process |
| `KNOWLEDGE_FS_ROOT` | `/data/shares` | Mount root for file-share sources; paths outside are rejected |
| `KNOWLEDGE_MAX_FILE_MB` | `50` | Maximum size of a single source document or upload |

## Audit

| Variable | Default | Description |
| --- | --- | --- |
| `AUDIT_LOG_PROMPTS` | `false` | Also store the full prompt / search text in audit entries. Clarify with data protection before enabling. |
