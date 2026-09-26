# AI Portal

Self-hosted web application for internal use of generative AI: a chat interface in the style of Claude or Google's AI Mode, with user management, centrally managed AI providers, per-user MCP servers, file uploads, an internal knowledge base and a complete audit log.

> Deutsche Fassung: [README.de.md](README.de.md)

## Features

- **Chat** with streaming answers, Markdown, tool calls shown inline, attachments (logs, code, PDF, Office documents, images)
- **Sign-in** with local accounts, LDAP / Active Directory and OIDC (Azure AD / Entra ID, Keycloak, …) in parallel; roles *admin* and *user*; group sync
- **AI providers** configured by admins: Anthropic Claude, AWS Bedrock, GitHub Models / GitHub Enterprise, any OpenAI-compatible endpoint; users choose from an approved model catalog
- **Per-user MCP servers** (Streamable HTTP, SSE) with encrypted credentials
- **Knowledge base (RAG)** from uploads, file shares, Confluence (Cloud and Server/DC) and SharePoint / OneDrive — text only, every hit links to its source; hybrid search (pgvector + full text); access per collection and group
- **Knowledge base as an MCP server** at `/mcp` for LibreChat, Claude Desktop, IDEs — with personal access tokens
- **Audit log** in PostgreSQL (UI with filters and CSV export) and as JSON on stdout
- **Runs anywhere containers run:** one stateless image + PostgreSQL; Docker Compose and Kubernetes manifests included

The user interface is available in **German and English** (switch in the top bar and on the sign-in page; the browser language is the default). Server messages follow the selected language.

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
| [Administration guide](docs/administration.md) | Users and groups, sign-in methods, providers and models, knowledge base, audit log |
| [User guide](docs/user-guide.md) | Chat, attachments, knowledge base, MCP servers, access tokens |
| [API & MCP reference](docs/api.md) | REST endpoints, streaming format, MCP endpoint and tools |
| [Security & audit](docs/security.md) | Security model, hardening, audit events, data handling |

The architecture concept (options, decision log, design) is maintained as a separate document.

## Development

```bash
# PostgreSQL 16 with pgvector running locally, then:
cd server && npm ci && npm run dev    # API on :8080, migrations run on start
cd web && npm ci && npm run dev       # UI on :5173, proxies /api to :8080
```

Schema changes: edit `server/src/db/schema.ts`, then `npm run db:generate` (writes SQL to `server/drizzle/`).

Translations: UI texts are written in German and wrapped in `t('…')`; the English texts live in `web/src/i18n.en.ts`. `npm run i18n:check` (in `web/`) fails if a text has no English version. Server messages are translated in `server/src/i18n.ts`.

## License

Internal project. Third-party dependencies keep their own licenses.
