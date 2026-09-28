# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

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

[Unreleased]: https://github.com/Tommi2Day/ai-portal/compare/0.0.2...HEAD
[0.0.2]: https://github.com/Tommi2Day/ai-portal/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/Tommi2Day/ai-portal/releases/tag/0.0.1
