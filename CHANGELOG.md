# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-11-15

First feature complete release: OAuth2/SSO for the GUI and `/mcp`, OAuth client credentials for MCP servers, central secret masking, web and Confluence page-tree knowledge sources with automatic/manual/webhook updates, source settings, admin notes, and ESLint plus reworked CI.

### Added
- **Source settings panel** (*Settings* on a knowledge source): a **Source active** switch (stops scheduled and external updates, manual sync still works, documents stay searchable; disabled sources are marked in the table) and a **credentials form** per source type that replaces the stored set completely (Confluence Cloud e-mail + API token, Server/DC token, SharePoint client secret, web headers; nothing is ever shown, *Replace & sync* tests new credentials at once). The API validates the credentials shape per source type; an empty set removes a web source's headers.
- **Knowledge sources**
  - New source type **Web pages (HTTP)**: crawls start URLs and follows links to subpages on the same host and path (`includeSubpages`, `maxDepth`, `maxPages`, `pathPrefix`, `exclude`), honours `<meta name="robots">`, optional request header stored encrypted. Needs migration `0010`.
  - Confluence **page trees** (`rootPageIds`) with configurable subpages (`includeSubpages`, `maxDepth`); without subpages a space imports only its top-level pages.
  - **Update mode per source**: automatic (interval), manual, or triggered externally by a webhook (`POST /api/hooks/knowledge/<id>/sync`, per-source token shown once and stored only as a hash, `X-Trigger-Token` or Bearer, rate-limited, audited; the admin UI shows the public webhook URL). Migration `0011`.
  - **Full replace** (`replaceOnSync`, *Replace completely* in the source's *Settings* panel, `{"replace": true}` per call): every document is re-imported in place and overwrites the stored content, subpages as configured. Content is replaced and vanished documents are removed only after the source was read completely; an unreadable source, or a full replace that finds nothing, keeps the existing content.
- **Single sign-on and OAuth**
  - SSO admins and allowed users by directory group, e-mail, `*@domain` or object ID (`OIDC_ADMIN_GROUPS`, `OIDC_ADMIN_USERS`, `OIDC_ALLOWED_GROUPS`, `OIDC_ALLOWED_USERS`, `OIDC_REQUIRE_VERIFIED_EMAIL`), deny by default once an allow list exists, plus the admin tab *Single Sign-On* to manage assignments at runtime.
  - OAuth 2.0 / OIDC access tokens on the knowledge `/mcp` endpoint (`MCP_OAUTH_*`): local JWT validation via JWKS, protected-resource metadata at `/.well-known/oauth-protected-resource`, access only for known OIDC users.
  - Per-user MCP servers can authenticate with OAuth 2.0 client credentials; the portal fetches and caches the tokens, the secret is stored encrypted. Migration `0009`.
- **Admin UI**: a *Comment* column (inline edit, up to 300 characters, 200 for SSO assignments) for users, AI providers, models, knowledge collections and sources, and SSO assignments; stored in a new `comment` column (migration `0012`), audited, admin-only.
- **Quality and delivery**
  - ESLint with typescript-eslint in `server/` and `web/` (plus the `react-hooks` rules in the UI), `npm run lint` / `npm run lint:fix`, warnings are fatal.
  - GitHub workflows reworked as in pg-mcp-server: CI *Lint & Test* → *Integration* / *Docker image build*; the release workflow lints, validates the version, rolls the CHANGELOG on a manual start, creates the tag and the GitHub release (notes from the CHANGELOG); Dependabot configuration with an automerge workflow; `DOCKERHUB.md` published as the Docker Hub description.
  - Integration tests with real servers: Keycloak (realm with clients and users), pg-mcp-server with and without OAuth, a full SSO sign-in round trip, the portal's own `/mcp` with Keycloak tokens, and the web source against a real web server.
- **Deployment**
  - **Helm chart** `helm/ai-portal` (config map, generated or existing secret, optional CloudNativePG database, ingress, HPA, PDB, network policy, extra volumes/env); published to `oci://ghcr.io/<owner>/charts` by the new `helm-publish.yml`, which the release workflow calls (a manual release also bumps `Chart.yaml`).
  - **GitHub Container Registry mirror** `ghcr.io/tommi2day/ai-portal` with the same tags; the release and chart workflows verify with an anonymous pull that the packages are public (GitHub has no API to set visibility, so the first release needs a one-time manual *Change visibility* in the package settings).
  - **Traefik and Keycloak for Docker Compose:** `docker-compose.support.yaml` adds Traefik (TLS, optional Let's Encrypt or own certificate, HTTP → HTTPS redirect) and Keycloak as OIDC provider (realm `ai-portal` imported from `deploy/keycloak/ai-portal-realm.json`, placeholders only, secrets from `.env`), both routed by labels, and two scripts for the admin API: `scripts/keycloak-user.sh` (add/list/delete users, reset passwords, push a changed client secret) and `scripts/keycloak-oidc.sh` (groups and members; OIDC applications as code-flow, public or service-account clients with PKCE, redirect URIs, audience, secrets; built-in and portal clients protected), sharing `scripts/keycloak-lib.sh`; `docker-compose.yml` carries the portal's Traefik labels and the Keycloak OIDC defaults. The chart gets `traefik.*` values that render a Traefik `IngressRoute` plus redirect.

### Changed
- CI job names changed (*Lint & Test (server|web)*, *Integration*, *Docker image build*); update required status checks in branch protection.
- Action buttons in the admin tables wrap instead of overflowing the card; the knowledge source table shows the update mode and the note, *Replace completely* moved into the source's *Settings* panel.
- `POST /api/admin/knowledge/sources/:id/sync` accepts `{replace}`; sync runs record their trigger (`schedule`, `manual`, `external`) and whether they replaced.
- Administration and installation guides completed: first steps, the Single Sign-On tab, collection and source management, sync problems with their messages, credential rotation and admin recovery; settings overview, published image and tags, first start, reverse-proxy requirements, data growth and retention, restore and more troubleshooting.
- The sign-in button label comes from `OIDC_DISPLAY_NAME` (documented with neutral examples such as `SSO`).

### Security
- Secrets are masked in logs, audit entries, stored error texts and the UI: central redaction (`server/src/redact.ts`) for every log record and audit details (also when entries are read or exported), URLs with secret parameters are masked, errors are reduced to type, message and status. Password and API-key prompts are masked inputs instead of `window.prompt`; new access tokens and webhook tokens stay hidden until revealed.
- OAuth hardening after a review: asymmetric JWT algorithms only on `/mcp`, groups from OAuth tokens are authoritative (no stale groups from the last sign-in), client-credentials tokens are cached under a hash key for at most 24 hours, token responses are limited to 64 KB, startup warnings for an `http` issuer, a missing `MCP_OAUTH_AUDIENCE` and several allowed issuers. New section "OAuth and SSO: what to know" in `docs/security.md`.
- The webhook token belongs to one source, is compared in constant time and answers every authentication failure with the same 401; the Docker Hub description action is pinned to a commit.

## [0.2.2] - 2026-11-06

Docker image: `tommi2day/ai-portal:0.2.2`.

### Security

- Updated npm dependencies within their semver ranges (lockfiles only), fixing the `undici`, `vite`, `zod`,
  `source-map-js` and related advisories. `npm audit` in `web/` is clean; in `server/` only the dev-only
  `esbuild` advisory behind `drizzle-kit` remains.
- Docker image and CI now use Node 24 LTS (`node:24-alpine`), and npm/npx/corepack are removed from the runtime
  stage, which dropped the HIGH findings from npm's bundled packages in the image scan.

## [0.2.1] - 2026-10-02

Docker image: `tommi2day/ai-portal:0.2.1`.

### Fixed

- Filesystem knowledge source: on Windows, the document `externalId`/`title` kept the OS path separator (`\`)
  instead of `/`, so the same share synced from Windows and Linux produced different document identities.

## [0.2.0] - 2026-10-02

Version re-baseline: no functional changes since 0.0.3. The numbering continues at 0.2.0 so that it stays above the
releases already built downstream. Docker image: `tommi2day/ai-portal:0.2.0`.

## [0.0.3] - 2026-10-02

Code-deployed plugins, contributed knowledge articles, self-registration for local accounts, a profile page for
first LDAP/OIDC sign-in, and document provenance (author/source/last change) throughout the knowledge base.
Database migrations 0006–0008 run at start; no manual steps. Docker image: `tommi2day/ai-portal:0.0.3`.

### Added

- Code-deployed plugins (`server/src/plugins/`, `web/src/plugins/`): authenticated API routes, namespaced chat tools
  (`plugin_<id>__<tool>`) and bundled UI pages, enabled per plugin by admins (default off, persisted in `settings`,
  checked again at every call, audited as `plugin.update` / `plugin.tool_call`). Sample plugin *Text statistics*;
  see `docs/plugins.md`.
- Contributed knowledge articles: signed-in users submit Markdown articles to collections they can access, admins
  approve or reject them under *Knowledge base → Review articles*. Unapproved articles are not searchable, readable or
  openable (search, document open, MCP). At most 10 open submissions per user; stale reviews can be rejected or retried.
- Self-registration for local accounts (`REGISTRATION_ENABLED`, default `false`): sign-up form with full name, email,
  username and password; accounts stay inactive (*Awaiting approval*) until an admin activates them.
  `POST /api/auth/register`, rate-limited.
- Profile page after the first LDAP/OIDC sign-in: full name and email prefilled from the directory, confirmed or
  corrected once (`PUT /api/auth/profile`, `profileCompleted` in `GET /api/auth/me`).
- Author, data source and last-change time per knowledge document (Confluence, SharePoint/OneDrive, file shares,
  uploads, articles), returned on request: `GET /api/knowledge/search?meta=1`, `GET /api/knowledge/documents/:id/meta`,
  parameter `metadaten` of the MCP tools `wissensdatenbank_suchen` / `dokument_lesen` and of the chat tool; author and
  last-change columns in the admin document list. Existing documents are filled in on the next sync where the source
  lists the values.
- Audit actions `auth.register`, `auth.profile`, `knowledge.article.submit|approve|reject`, `plugin.update`,
  `plugin.tool_call`.

### Changed

- Directory sync: an empty LDAP/OIDC name or email attribute no longer erases a stored value.
- Default `DATABASE_URL` without a password (`postgres://aiportal@localhost:5432/aiportal`): set the full URL or
  `PGPASSWORD` for anything but a trust-auth local database.
- Code quality (SonarQube): the chat stream handling moved into `server/src/ai/answer.ts` (`AnswerRecorder`, prompt and
  message building) and `web/src/chatStream.ts`; `chunkText` and the knowledge sync split into smaller functions;
  no regexes with super-linear backtracking (`trimSlashes()`), `replaceAll`, explicit `type` on form buttons.
- Tests: chat answer recording, Confluence and SharePoint connectors, LDAP sign-in, embedding factory, MCP session,
  login page and MCP settings page (jsdom).
- API tests (`server/test/api.test.ts`): the real app (`createApp()` in the new `server/src/app.ts`, `main.ts` only
  starts it) against an in-process PostgreSQL (PGlite with pgvector, dev dependencies `@electric-sql/pglite`,
  `@electric-sql/pglite-pgvector`, real migrations) and the scripted mock LLM of the integration tests: sign-in, CSRF,
  users, providers and models, embedding probe, knowledge upload, file-share sync and hybrid search, attachments, chat
  with knowledge-base and MCP tool calls, the knowledge base as MCP server with access tokens, audit log and CSV export.
  Coverage of `server/` and `web/` together about 60 % (SonarQube).

### Fixed

- Bootstrap admin: several replicas starting at the same time on an empty database no longer crash one pod
  (`onConflictDoNothing`).
- `sort()` without compare function for LDAP/OIDC groups (now `localeCompare`) and XLSX sheets (now numeric, `sheet2`
  before `sheet10`).
- Chat streaming (`streamText` in `server/src/routes/chats.ts`): every provider error (context length, rate limit, …)
  was also dumped to stderr via the AI SDK's default `onError`, even though it is already captured and reported to
  the client; now a no-op `onError` suppresses the redundant logging.
- AI provider errors (context length, rate limit, invalid API key, overloaded, content filter, model not found) arrive
  in English from the provider's API regardless of UI language; known phrasings are now translated back to German for
  German UIs (`server/src/i18n.ts`), matching how the rest of the app's user-facing text is localized.

## [0.0.2] - 2026-09-28

AWS Bedrock without stored secrets: IAM role with self-renewing short-term API keys (optionally assuming a role), and
the model selection of the admin UI lists the models of the AWS account. Docker image: `tommi2day/ai-portal:0.0.2`.

### Added

- AWS Bedrock authentication *IAM role (short-term API keys)*: no stored secret; the portal takes its identity from
  the AWS default credential chain (EKS Pod Identity, IRSA, instance profile, `AWS_*` variables), optionally assumes a
  configured role (role ARN, external ID), signs short-term Bedrock API keys locally (`@aws/bedrock-token-generator`)
  and renews them before they expire or after a `401`/`403` (`BEDROCK_TOKEN_TTL_SECONDS`, default 1 h). Chat and
  embeddings use it. The provider option `auth` (`iam`, `keys`, `apiKey`) selects the mode; existing providers keep
  their stored keys.
- Model selection from the AWS account: `GET /api/admin/providers/:id/available-models` lists the inference profiles,
  on-demand foundation models and embedding models of the account in the provider's region with legacy flag and model
  access (`GetFoundationModelAvailability`), cached for 10 minutes; `BEDROCK_INFERENCE_PROFILE_PREFIXES` limits the
  profiles (e.g. `eu.`). The admin UI uses it when approving models and choosing the embedding model, and falls back to
  the presets (other provider types, static Bedrock API key, missing permissions).

## [0.0.1] - 2026-09-27

First release. The portal: chat with streaming and attachments, sign-in with local accounts, LDAP/AD and OIDC,
centrally managed AI providers (Anthropic, AWS Bedrock, GitHub Models, OpenAI-compatible) with an approved model
catalog, per-user MCP servers, knowledge base (uploads, file shares, Confluence, SharePoint) also exposed as MCP
server, audit log, German and English UI, Docker Compose and Kubernetes manifests. Docker image:
`tommi2day/ai-portal:0.0.1`.

### Added

- MIT license (`LICENSE`, `license` in both `package.json` files, badge and license section in the READMEs).
- Web UI branding: `PORTAL_NAME` (name in the top bar, on the sign-in page and in the browser tab), `PORTAL_LOGO`
  (logo file embedded as data URI, or an http(s) URL that is added to the CSP `img-src`) and `PORTAL_THEME_CSS`
  (stylesheet loaded after the built-in one, overrides the color/font variables in `web/src/styles.css`). The server
  injects them into `index.html` at startup; unreadable files are logged and the built-in design is used. New CSS
  variables `--logo-height` / `--header-logo-height`. Example theme in `examples/branding/`, screenshots in
  `docs/configuration.md` (`docs/images/`); Docker Compose mounts `BRANDING_DIR` at `/branding`, Kubernetes
  manifests contain a commented-out `ai-portal-branding` ConfigMap mount.
- Documentation on connecting LLM providers: new `docs/llm-providers.md` (per provider type: API called, credentials,
  Bedrock IAM policy and inference profiles, GitHub organization endpoint, base-URL examples for Azure OpenAI, Ollama,
  vLLM, TEI and LiteLLM; what is sent to the provider; proxy and CA settings; operations; troubleshooting), German
  section "KI-Anbieter anbinden" in `README.de.md`, proxy variables (`NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
  `NODE_EXTRA_CA_CERTS`) in `docs/configuration.md`, `.env.example` and the Kubernetes ConfigMap.
- Architecture concept (English and German): subsections on the provider connection, the request and data flow to the
  provider and network/operations; security table row "AI providers"; open item on classifying data per provider;
  OpenAI-compatible endpoints in the overview diagram.
- Unit tests with Vitest (`npm test` in `server/` and `web/`, no database needed): branding, provider connection per
  type (mocked AI SDK), AES-256-GCM encryption, text chunking, SSRF guard for MCP URLs, file-share path confinement,
  LDAP escaping, session/CSRF guards, server and UI translations, text extraction (text, HTML, PPTX, XLSX), `Brand`
  component. Tests are type-checked (`tsconfig.test.json`).
- Integration tests (`npm run test:integration` in `server/`, stack in `docker-compose.test.yml`): the portal against
  PostgreSQL/pgvector, pg-mcp-server and oracle-mcp-server (Oracle Free) with a scripted OpenAI-compatible mock LLM –
  MCP tool loop down to the databases, provider requests (history, attachments, images, keys, key rotation, errors),
  knowledge base (upload, file-share sync, hybrid search, group permissions, chat tool, `/mcp` with tokens), branded
  `index.html` and CSP, access control and audit entries.
- GitHub Actions workflow `ci.yml`: unit tests with coverage upload to Codecov, `npm audit`, translation check and build
  for `server/` and `web/`, integration tests with the Docker stack, Docker image build with a start check.
- GitHub Actions workflow `release.yml`: on a tag `X.Y.Z` or manual start (with version bump on `main`) unit and
  integration tests, then build and push of `tommi2day/ai-portal` to Docker Hub.
- Screenshots of all pages in both READMEs (English UI in `README.md`, German UI in `README.de.md`; `docs/images/`).
- `.gitignore` for dependencies, build output, `.env` and IDE files; `.dockerignore` also excludes `docs` and
  `examples`.

### Fixed

- LDAP: group names containing an escaped comma (`CN=Team\, Ops,…`) were cut at the backslash (`Team\`) and did not
  match knowledge-base group permissions.
- Knowledge base: `chunkText` with `overlap = 0` repeated the complete previous chunk in every chunk (not reachable with
  the default overlap of 300).

[Unreleased]: https://github.com/Tommi2Day/ai-portal/compare/1.0.0...HEAD
[1.0.0]: https://github.com/Tommi2Day/ai-portal/compare/0.2.2...1.0.0
[0.2.2]: https://github.com/Tommi2Day/ai-portal/compare/0.2.1...0.2.2
[0.2.1]: https://github.com/Tommi2Day/ai-portal/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/Tommi2Day/ai-portal/compare/0.0.3...0.2.0
[0.0.3]: https://github.com/Tommi2Day/ai-portal/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/Tommi2Day/ai-portal/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/Tommi2Day/ai-portal/releases/tag/0.0.1
