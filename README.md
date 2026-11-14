# AI Portal

[![CI](https://github.com/Tommi2Day/ai-portal/actions/workflows/ci.yml/badge.svg)](https://github.com/Tommi2Day/ai-portal/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Tommi2Day/ai-portal/graph/badge.svg)](https://codecov.io/gh/Tommi2Day/ai-portal)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/tommi2day/ai-portal)](https://github.com/Tommi2Day/ai-portal/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/tommi2day/ai-portal?logo=docker)](https://hub.docker.com/r/tommi2day/ai-portal)
[![License: MIT](https://img.shields.io/github/license/tommi2day/ai-portal)](LICENSE)

Self-hosted web application for internal use of generative AI: a chat interface in the style of Claude or Google's AI Mode, with user management, centrally managed AI providers, per-user MCP servers, file uploads, an internal knowledge base and a complete audit log.

> Deutsche Fassung: [README.de.md](README.de.md)

## Features

- **Chat** with streaming answers, Markdown, tool calls shown inline, attachments (logs, code, PDF, Office documents, images)
- **Sign-in** with local accounts, LDAP / Active Directory and OIDC single sign-on (Azure AD / Entra ID, Keycloak, …) in parallel; roles *admin* and *user*; group sync; SSO admins and allowed users by group, e-mail or object ID, managed in the admin UI
- **AI providers** configured by admins: Anthropic Claude, AWS Bedrock, GitHub Models / GitHub Enterprise, any OpenAI-compatible endpoint; users choose from an approved model catalog
- **Per-user MCP servers** (Streamable HTTP, SSE) with encrypted credentials — static headers or OAuth 2.0 client credentials (the portal fetches and caches the tokens)
- **Code-deployed plugins** for chat tools, authenticated API endpoints and UI pages; admins can disable them ([plugin guide](docs/plugins.md))
- **Knowledge base (RAG)** from uploads, file shares, Confluence (Cloud and Server/DC, whole spaces or page trees with configurable subpages), SharePoint / OneDrive and web pages (HTTP crawler with subpage links) — updated automatically, manually or by an external trigger (webhook), incrementally or as a full replace of the stored content — text only, every hit links to its source, with author and last-change time on request; hybrid search (pgvector + full text); access per collection and group
- **Sign-up and profile:** optional self-registration with admin approval; LDAP/Entra users confirm name and email (prefilled from the directory) at first sign-in
- **Contributed articles** written in the browser by signed-in users and reviewed by admins before they enter the knowledge base
- **Knowledge base as an MCP server** at `/mcp` for LibreChat, Claude Desktop, IDEs — with personal access tokens or OAuth 2.0 access tokens from your identity provider
- **Audit log** in PostgreSQL (UI with filters and CSV export) and as JSON on stdout
- **Admin notes:** a comment column on users, providers, models, collections, sources and SSO assignments for small notes (ticket, owner, expiry); admin-only
- **Secrets stay secret:** credentials are write-only and masked in logs, audit entries, error texts and the UI (new tokens stay hidden until revealed)
- **Branding:** own name, logo and colors via environment variables, no rebuild ([configuration](docs/configuration.md#branding))
- **Runs anywhere containers run:** one stateless image + PostgreSQL; Docker Compose and Kubernetes manifests included

The user interface is available in **German and English** (switch in the top bar and on the sign-in page; the browser language is the default). Server messages follow the selected language.

## Screenshots

**Chat** — answer with knowledge-base hits, an MCP tool call (Oracle database) and sources:

![Chat with knowledge-base search, MCP tool call and sources](docs/images/chat.en.png)

<table>
  <tr>
    <td width="50%" valign="top"><b>MCP servers and access tokens</b> — per-user MCP servers (headers or OAuth 2.0 client credentials); the knowledge base as MCP server for other tools<br><img src="docs/images/mcp.en.png" alt="MCP servers and access tokens"></td>
    <td width="50%" valign="top"><b>Providers and models</b> — AI providers and the model catalog users choose from, with admin notes<br><img src="docs/images/admin-providers.en.png" alt="Administration: providers and models"></td>
  </tr>
  <tr>
    <td valign="top"><b>Knowledge base</b> — embedding model, collections with access groups, sources with update mode, sync status and notes<br><img src="docs/images/admin-knowledge.en.png" alt="Administration: knowledge base"></td>
    <td valign="top"><b>Users</b> — local, LDAP and SSO users with roles, groups and notes<br><img src="docs/images/admin-users.en.png" alt="Administration: users"></td>
  </tr>
  <tr>
    <td valign="top"><b>Audit log</b> — filter and CSV export<br><img src="docs/images/admin-audit.en.png" alt="Administration: audit log"></td>
    <td valign="top"><b>Sign-in</b> — local, LDAP and SSO; <a href="docs/configuration.md#branding">with your own logo and colors</a><br><img src="docs/images/login.en.png" alt="Sign-in page with company account (LDAP), local account and single sign-on"><br><img src="docs/images/branding-login.png" alt="Sign-in page with corporate branding"></td>
  </tr>
  <tr>
    <td valign="top"><b>Single sign-on</b> — SSO admins and allowed users by group, e-mail or object ID<br><img src="docs/images/admin-sso.en.png" alt="Administration: single sign-on assignments"></td>
    <td valign="top"><b>Source settings</b> — active switch, update mode (automatic, manual or webhook), full replace of the stored content, credentials, webhook URL<br><img src="docs/images/admin-knowledge-update.en.png" alt="Administration: settings of a knowledge source"></td>
  </tr>
</table>

## Repository layout

```
server/        Node.js 22 · Express 5 · Drizzle/PostgreSQL · Vercel AI SDK · MCP SDK
  src/auth/        local, LDAP, OIDC sign-in, sessions
  src/ai/          provider factory, MCP client
  src/knowledge/   embeddings, chunking, connectors, sync, search, MCP server
  src/routes/      REST API
  drizzle/         SQL migrations (applied on start)
web/           React 19 · Vite
deploy/k8s/    Kubernetes manifests (kustomize)
docs/          English documentation
```

## Quick start (Docker Compose)

```bash
cp .env.example .env
# set SESSION_SECRET (openssl rand -hex 32), ENCRYPTION_KEY (openssl rand -base64 32)
# and BOOTSTRAP_ADMIN_PASSWORD
docker compose up --build
```

Open http://localhost:8080, sign in as `admin` and go to **Administration**:

1. **Anbieter & Modelle** (providers & models): add a provider, e.g. *Anthropic Claude* with an API key, then approve models and mark one as default.
2. **Wissensdatenbank** (knowledge base, optional): choose an embedding model, create a collection, add sources.

Users add their own MCP servers under **MCP-Server**.

## Documentation

| Document | Content |
| --- | --- |
| [Installation & operations](docs/installation.md) | Docker Compose, Kubernetes, PostgreSQL/pgvector, file shares, backups, upgrades, monitoring |
| [Configuration reference](docs/configuration.md) | Every environment variable with default and meaning |
| [Connecting LLM providers](docs/llm-providers.md) | Anthropic, AWS Bedrock, GitHub Models, OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM, LiteLLM): credentials, IAM, base URLs, proxy, data flow, troubleshooting |
| [Administration guide](docs/administration.md) | Users and groups, sign-in methods, providers and models, knowledge base, audit log |
| [User guide](docs/user-guide.md) | Chat, attachments, knowledge base, MCP servers, access tokens |
| [API & MCP reference](docs/api.md) | REST endpoints, streaming format, MCP endpoint and tools |
| [Plugins](docs/plugins.md) | Writing and registering trusted server/UI plugins, admin toggles, sample plugin |
| [Security & audit](docs/security.md) | Security model, hardening, audit events, data handling |

The architecture concept (options, decision log, design) is maintained as a separate document.

## Development

```bash
# PostgreSQL 16 with pgvector running locally, then:
cd server && npm ci && npm run dev    # API on :8080, migrations run on start
cd web && npm ci && npm run dev       # UI on :5173, proxies /api to :8080
```

Unit and API tests (Vitest, no external database: the API tests run the real app against an in-process PostgreSQL — PGlite with pgvector — and a scripted mock LLM; type-checks the tests first):

```bash
cd server && npm test    # API (auth, admin, chat with tool calls, files, knowledge upload/sync/search, MCP), Bedrock auth, connectors, LDAP, embeddings, encryption, chunking, SSRF guard, i18n, text extraction
cd web && npm test       # login and MCP pages, chat stream handling, model selection, brand component, UI translations
```

`npm run test:watch` re-runs tests on changes.

Linting (ESLint with typescript-eslint, plus the React hooks rules in `web/`; warnings fail the run): `npm run lint` in `server/` and `web/`, `npm run lint:fix` applies the automatic fixes. CI runs the linters before the tests.

Integration tests run the portal against real PostgreSQL/pgvector, [pg-mcp-server](https://github.com/Tommi2Day/pg-mcp-server) (with and without OAuth, against a real Keycloak) and [oracle-mcp-server](https://github.com/Tommi2Day/oracle-mcp-server) (with Oracle Free) in Docker, with a scripted mock LLM — the complete chain portal → model → MCP tool → database → answer, the knowledge base and the provider requests. Details: [server/test/integration](server/test/integration/README.md).

```bash
docker compose -f docker-compose.test.yml up -d --wait
cd server && npm run test:integration      # IT_SKIP_ORACLE=1 without the Oracle containers
```

GitHub Actions (`.github/workflows/`):

| Workflow | What it does |
| --- | --- |
| `ci.yml` | On every push and pull request: **Lint & Test** for `server/` and `web/` (audit, ESLint, translation check, tests with coverage uploaded to Codecov, build), then the **integration tests** against the Docker stack (PostgreSQL/pgvector, Keycloak, pg-mcp-server with and without OAuth, Oracle + oracle-mcp-server) and a **Docker image build** with a start-up smoke test |
| `release.yml` | Publishes the image [`tommi2day/ai-portal`](https://hub.docker.com/r/tommi2day/ai-portal) on Docker Hub and creates the GitHub release after lint, unit and integration tests. Push a tag `X.Y.Z` (→ `:X.Y.Z`, `:X.Y`, `:X`, `:latest`, `:sha-<short>`), or start the workflow manually with a version: it validates the version, sets it in both `package.json` files and `deploy/k8s/kustomization.yaml`, rolls `## [Unreleased]` of the CHANGELOG into `## [X.Y.Z]`, commits to `main` and creates the tag. The release notes are that CHANGELOG section plus the generated list of pull requests |
| `dependabot-automerge.yml` | Dependabot (`.github/dependabot.yml`, monthly: npm for `server/` and `web/`, Docker, Actions) pull requests are updated and set to auto-merge once the required checks pass; major version bumps are left for manual review |
| `dockerhub-description.yml` | Pushes `DOCKERHUB.md` (the compact README) and the short description to Docker Hub when it changes on `main` |

Repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (token with Read, Write, Delete scope), `CODECOV_TOKEN`. Auto-merge needs “Allow auto-merge” and branch protection with the CI checks as required status checks.

Schema changes: edit `server/src/db/schema.ts`, then `npm run db:generate` (writes SQL to `server/drizzle/`).

Translations: UI texts are written in German and wrapped in `t('…')`; the English texts live in `web/src/i18n.en.ts`. `npm run i18n:check` (in `web/`) fails if a text has no English version. Server messages are translated in `server/src/i18n.ts`.

## License

[MIT](LICENSE). Third-party dependencies keep their own licenses.
