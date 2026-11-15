# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI Portal: a self-hosted web app for internal generative-AI use — chat (Claude-style), user management (local/LDAP/OIDC), admin-managed AI providers, per-user MCP servers, file uploads, an internal knowledge base (RAG), and a full audit log. One stateless Node image + PostgreSQL (pgvector).

Two packages, each with its own `package.json`, built/tested independently:

```
server/        Node.js 22 · Express 5 · Drizzle ORM/PostgreSQL · Vercel AI SDK · MCP SDK · TypeScript
  src/auth/        local, LDAP, OIDC sign-in, sessions
  src/ai/          provider factory (Anthropic/Bedrock/OpenAI-compatible), MCP client, answer streaming
  src/knowledge/   embeddings, chunking, connectors (filesystem/Confluence/SharePoint/http), sync, hybrid search, MCP server
  src/plugins/     built-in trusted plugins (chat tools + HTTP routes + UI page)
  src/routes/      REST API routers, mounted in src/app.ts
  src/db/          Drizzle schema (schema.ts) and connection (index.ts)
  drizzle/         generated SQL migrations (applied automatically on start)
  test/            Vitest unit/API tests; test/integration/ real-stack integration tests (separate config)
web/           React 19 · Vite · TypeScript (no React Router — App.tsx switches views by state)
deploy/k8s/    Kubernetes manifests (kustomize)
helm/ai-portal/ Helm chart (values.yaml documents all options); docker-compose.support.yaml = optional Traefik + Keycloak (deploy/traefik, deploy/keycloak; scripts/keycloak-user.sh, keycloak-oidc.sh (groups, OIDC apps) and keycloak-lib.sh manage Keycloak through its admin API)
docs/          English documentation (README.de.md is the German README)
```

## Commands

Run from `server/` or `web/` respectively (not the repo root — there is no root `package.json`).

```bash
# Local dev (needs PostgreSQL 16 + pgvector reachable via DATABASE_URL)
cd server && npm ci && npm run dev    # API on :8080, Drizzle migrations run automatically on start
cd web && npm ci && npm run dev       # UI on :5173, proxies /api to :8080

# Tests — both run tsc first (type-checks tests), then Vitest. No external DB needed:
# server tests spin up an in-process PGlite+pgvector Postgres and a scripted mock LLM.
cd server && npm test
cd web && npm test
cd server && npm run lint   # ESLint (typescript-eslint); web/ also has the react-hooks rules; --max-warnings 0, `npm run lint:fix` fixes what it can
npm run test:watch       # either package: watch mode, skips the typecheck step

# Single test file / name (after the typecheck, or skip it with test:watch):
cd server && npx vitest run test/routes/chats.test.ts
cd server && npx vitest run -t "name substring"

# Integration tests (real PostgreSQL/pgvector + pg-mcp-server + oracle-mcp-server in Docker)
docker compose -f docker-compose.test.yml up -d --wait
cd server && npm run test:integration      # IT_SKIP_ORACLE=1 to skip the Oracle containers
# see server/test/integration/README.md for details

# Lint/translation/build
cd web && npm run i18n:check   # fails if a German UI string has no English translation
cd server && npm run build     # tsc -> dist/
cd web && npm run build        # tsc --noEmit && vite build

# DB schema changes
# 1. edit server/src/db/schema.ts
# 2. cd server && npm run db:generate   # writes SQL into server/drizzle/
```

Workflows (`.github/workflows/`): `ci.yml` runs per package `npm audit --audit-level=high`, `npm run lint`, i18n check (web only), `npm test -- --coverage` (uploaded to Codecov), `npm run build`, then a separate integration job and a Docker image build/smoke-test job. `release.yml` (tag `X.Y.Z` or manual start with a version) runs lint + unit + integration tests, pushes `tommi2day/ai-portal` to Docker Hub and `ghcr.io/tommi2day/ai-portal` (a final step fails the run if the GHCR package is not public — visibility can only be set once by hand in the package settings, there is no API) and creates the GitHub release (notes = CHANGELOG section `## [X.Y.Z]`; a manual start also bumps the package.json files, `deploy/k8s/kustomization.yaml` and rolls the CHANGELOG's Unreleased section). `helm-publish.yml` (called by release.yml: lints, packages and pushes the chart to `oci://ghcr.io/<owner>/charts`; a manual release also bumps `helm/ai-portal/Chart.yaml`), `dependabot-automerge.yml` + `dependabot.yml` auto-merge non-major dependency updates, `dockerhub-description.yml` publishes `DOCKERHUB.md`. The Node major is set in ci.yml, release.yml and the Dockerfile — bump all of them by hand (Dependabot ignores Node majors).

## Architecture notes

**Request pipeline** (`server/src/app.ts`): helmet + cookie-parser + json body → `/healthz`, `/readyz` (liveness/readiness, no auth) → `/api/*` gets i18n + session + CSRF guard middleware → per-router `requireAuth`/`requireAdmin` → routers mounted at `/api/auth`, `/api/admin`, `/api/mcp-servers`, `/api/files`, `/api/models`, `/api/chats`, `/api/tokens`, `/api/admin/plugins`, `/api/plugins`, and (if `KNOWLEDGE_ENABLED`) `/api/admin/knowledge`, `/api/knowledge`, `/mcp`. Everything under `/api` not matched returns 404; everything else falls through to the SPA's `index.html` (rendered once at startup with branding injected). `createApp()` takes no listen call — `main.ts` wires that plus the bootstrap-admin step and startup migrations.

**Secrets in text**: everything that leaves the process as text goes through `server/src/redact.ts` — `logger.ts` applies `redactDeep` to every log record, `audit()` masks details on write and `routes/admin.ts` on read, and errors stored or shown to users use `safeErrorText`/`maskString`. When adding a secret field, name it like `*secret`/`*password`/`apiKey`/`token` (see `isSensitiveKey`), keep it write-only in API views, and use `SecretButton`/`type="password"` in the UI — never `window.prompt()`.

**Config** (`server/src/config.ts`): a single Zod schema validates `process.env` at import time and crashes fast with a readable error if `SESSION_SECRET`/`ENCRYPTION_KEY` etc. are missing or malformed (this is asserted in CI's Docker smoke test). All env vars are documented in `docs/configuration.md` — add new ones there when extending `config.ts`.

**Auth** (`server/src/auth/`): three sign-in sources — local (bcrypt), LDAP/AD (`ldapts`), OIDC (`openid-client`, e.g. Entra ID/Keycloak) — can run in parallel, selected by `AUTH_LOCAL_ENABLED`/`LDAP_ENABLED`/`OIDC_ENABLED`. `session.ts` issues JWT-backed sessions (cookie) and exposes `sessionMiddleware`, `csrfGuard`, `requireAuth`, `requireAdmin`. `provision.ts` handles first-sign-in account creation/confirmation for LDAP/OIDC users and self-registration approval flow. OIDC access/admin decisions live in `oidc.ts` (`evaluateClaims`: `OIDC_ALLOWED_*`/`OIDC_ADMIN_*` env lists plus the admin-UI assignments of `oidcAssignments.ts`, stored in `settings`); the same function guards OAuth access tokens on `/mcp` (`knowledge/mcpOauth.ts`, JWKS validation via `jose`, protected-resource metadata).

**AI providers** (`server/src/ai/`): `providers.ts` is a factory turning a DB-stored provider config (Anthropic Claude, AWS Bedrock, GitHub Models, or any OpenAI-compatible endpoint) + model id into a Vercel AI SDK model instance; credentials are encrypted at rest (`crypto.ts`, AES-256-GCM via `ENCRYPTION_KEY`). `answer.ts` drives the streaming chat loop, merging MCP tools (per-user servers, `ai/mcp.ts`; a server can authenticate with static headers or OAuth 2.0 client credentials — token fetch/cache in `fetchOAuthToken`, redirects refused, secret in `mcpServers.oauthEnc`) with chat-tool-shaped plugin tools (`plugins/index.ts`) before each turn. `bedrock.ts` handles AWS credential/token resolution.

**Plugins** (`server/src/plugins/`, `web/src/plugins/`): the extension point for trusted, code-shipped (never uploaded/sandboxed) features — see `docs/plugins.md` for the full contract. A plugin implements `PortalPlugin` (`plugins/types.ts`): optional Express `router` (mounted at `/api/plugins/<id>` after auth/CSRF), optional AI SDK `tools` (exposed to chat as `plugin_<id>__<tool>`, each `execute` must independently validate input — never trust model-supplied args), optional `hasPage` React UI registered under the matching ID in `web/src/plugins/index.ts`. Must be registered in `server/src/plugins/index.ts` to run. Enabled/disabled per-plugin by admins at runtime via the `settings` table (checked again immediately before each tool execution). `plugins/sample.ts` (Text statistics) is the reference implementation covering all three surfaces.

**Knowledge base / RAG** (`server/src/knowledge/`): sources are filesystem shares, Confluence (Cloud + Server/DC; spaces or page trees via `rootPageIds`/`includeSubpages`/`maxDepth`), SharePoint/OneDrive, or an origin-locked HTTP crawler (`connectors/http.ts`: depth/page limits, manual redirects, meta robots) (`connectors/`, implementing `connectors/types.ts`). `sync.ts` pulls (incremental, or `replace`: re-import everything in place; triggers: scheduler for `syncIntervalMinutes > 0`, admin button, or the per-source webhook in `routes/knowledgeHooks.ts`, mounted before the session/CSRF layer), `chunk.ts` splits, `embeddings.ts` embeds (admin-chosen embedding model) into `knowledgeChunks` (pgvector). `search.ts` does hybrid search (pgvector + Postgres full text) scoped by collection and the caller's groups. `mcpServer.ts` exposes the whole knowledge base as an MCP server at `/mcp` (rate-limited, token-authenticated via `mcpAuth`) for external clients (LibreChat, Claude Desktop, IDEs). Contributed articles (`knowledgeArticles` table, `routes/knowledge.ts`) are written in-browser by users and need admin review before becoming searchable documents.

**Database** (`server/src/db/schema.ts`, Drizzle): core tables are `users`, `providers`, `models`, `mcpServers`, `chats`/`messages`/`attachments`, `auditLog`, `settings` (plugin toggles + other cross-replica flags), `knowledgeCollections`/`knowledgeSources`/`knowledgeDocuments`/`knowledgeChunks`/`knowledgeArticles`, `apiTokens`. Migrations are generated (`npm run db:generate`) into `server/drizzle/` and applied automatically at process start — never hand-edit generated SQL; change `schema.ts` and regenerate.

**Admin notes**: users, providers, models, knowledge collections/sources have a nullable `comment` column (SSO assignments carry it in their JSON); the zod type is `commentField` (`server/src/comment.ts`: trimmed, max 300, empty = null) and the web cell is `CommentCell`. User-facing endpoints select explicit columns, so notes must never be added to them.

**i18n**: UI strings are authored in German inline via `t('…')` in `web/src/`; English strings live in `web/src/i18n.en.ts` and `npm run i18n:check` fails the build if one is missing. Server-side user-facing messages (errors, audit text) are translated in `server/src/i18n.ts`. When adding user-facing text, add both languages in the same change.

**Testing conventions**: server unit/API tests run the real Express app (`createApp`) against an in-process PGlite+pgvector Postgres and a scripted mock LLM — no network, no real Postgres — so most routes and the chat tool-call loop are tested end-to-end at the HTTP layer rather than through mocks. Integration tests (`server/test/integration/`, separate `vitest.integration.config.ts`) exercise the real chain against Docker (`docker-compose.test.yml`): Postgres/pgvector, `pg-mcp-server` (static token and, via Keycloak, OAuth — `mcp-oauth.it.test.ts`), `oracle-mcp-server`. Web tests (`web/test/`) use jsdom + Vitest for component/page behavior and stream handling.
