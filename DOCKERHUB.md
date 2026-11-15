# AI Portal

Self-hosted web application for the internal use of generative AI: a chat interface in the style of Claude or Google's AI Mode with user management, centrally managed AI providers, per-user MCP servers, file uploads, an internal knowledge base (RAG) and a complete audit log. One stateless Node image plus PostgreSQL (pgvector).

**Source, full documentation, Kubernetes manifests, Helm chart:** [github.com/Tommi2Day/ai-portal](https://github.com/Tommi2Day/ai-portal) · **Changelog:** [CHANGELOG.md](https://github.com/Tommi2Day/ai-portal/blob/main/CHANGELOG.md)

## Features

- **Chat** with streaming answers, Markdown, tool calls shown inline, attachments (logs, code, PDF, Office documents, images)
- **Sign-in** with local accounts, LDAP / Active Directory and OIDC single sign-on (Entra ID, Keycloak, …) in parallel; roles *admin* and *user*; SSO admins and allowed users by group, e-mail or object ID, managed in the admin UI
- **AI providers** configured by admins: Anthropic Claude, AWS Bedrock, GitHub Models / GitHub Enterprise, any OpenAI-compatible endpoint (Azure OpenAI, Ollama, vLLM, LiteLLM); users choose from an approved model catalog
- **Per-user MCP servers** (Streamable HTTP, SSE) with encrypted credentials: static headers or OAuth 2.0 client credentials
- **Knowledge base (RAG)** from uploads, file shares, Confluence (Cloud and Server/DC, whole spaces or page trees), SharePoint / OneDrive and web pages (crawler with subpage links); updated automatically, manually or by webhook, incrementally or as a full replace; text only, every hit links to its source; hybrid search (pgvector + full text); access per collection and group
- **Knowledge base as an MCP server** at `/mcp` for LibreChat, Claude Desktop, IDEs: personal access tokens or OAuth 2.0 access tokens from your identity provider
- **Plugins** for chat tools, API endpoints and UI pages (trusted, code-deployed, switchable by admins)
- **Audit log** in PostgreSQL (UI with filters and CSV export) and as JSON on stdout; secrets are masked in logs, audit entries and the UI
- User interface in German and English, your own logo and colors without rebuilding the image

## Quick start

```yaml
# docker-compose.yml
services:
  db:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_USER: aiportal, POSTGRES_PASSWORD: aiportal, POSTGRES_DB: aiportal }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U aiportal"], interval: 5s, retries: 10 }

  app:
    image: tommi2day/ai-portal:latest
    environment:
      DATABASE_URL: postgres://aiportal:aiportal@db:5432/aiportal
      PUBLIC_URL: http://localhost:8080
      SESSION_SECRET: ${SESSION_SECRET}          # openssl rand -hex 32
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}          # openssl rand -base64 32 (keep it: stored credentials need it)
      BOOTSTRAP_ADMIN_USER: admin
      BOOTSTRAP_ADMIN_PASSWORD: ${ADMIN_PASSWORD}
    ports: ["8080:8080"]
    depends_on: { db: { condition: service_healthy } }

volumes:
  pgdata:
```

```bash
export SESSION_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -base64 32) ADMIN_PASSWORD='change-me-please-123'
docker compose up -d      # then open http://localhost:8080 and sign in as admin
```

Database migrations run automatically on start. Without `SESSION_SECRET` / `ENCRYPTION_KEY` the container refuses to start with a readable error. Set `COOKIE_SECURE=true` behind HTTPS.

## Configuration

Everything is configured with environment variables, see the [configuration reference](https://github.com/Tommi2Day/ai-portal/blob/main/docs/configuration.md).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 16 with the `vector` extension |
| `PUBLIC_URL` | External base URL (OIDC redirect URI, links in MCP results) |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Signs sessions / encrypts stored credentials (AES-256-GCM) |
| `AUTH_LOCAL_ENABLED`, `LDAP_*`, `OIDC_*` | Sign-in methods, SSO admin and access rules |
| `MCP_OAUTH_*` | OAuth 2.0 access tokens on the knowledge MCP endpoint `/mcp` |
| `KNOWLEDGE_*` | Knowledge base (file-share root, size limit, background sync) |
| `PORTAL_NAME`, `PORTAL_THEME_CSS`, `PORTAL_LOGO` | Branding |
| `LOG_LEVEL`, `AUDIT_LOG_PROMPTS` | Logging; full prompt text in the audit only when enabled |

| Mount | Purpose |
| --- | --- |
| `/data/shares` (read-only) | File shares for knowledge-base sources (`KNOWLEDGE_FS_ROOT`) |
| `/branding` | Optional `theme.css` and logo (`PORTAL_THEME_CSS`, `PORTAL_LOGO`) |

Port `8080`; health endpoints `/healthz` (liveness) and `/readyz` (readiness). The image runs as non-root (`node`) and is stateless: scale it horizontally behind one PostgreSQL.

## Tags

`:X.Y.Z`, `:X.Y`, `:X` and `:latest` for releases, `:sha-<short>` for every build. Pin a version in production.

## Security

Provider keys, MCP headers and source credentials are encrypted at rest and write-only in the API; secrets are masked in logs, audit entries and the UI. Details and hardening notes (SSO and OAuth, SSRF, sessions): [Security & audit](https://github.com/Tommi2Day/ai-portal/blob/main/docs/security.md).

## License

MIT
