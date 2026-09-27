# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

## [1.0.0] - 2026-09-26

Initial release.
