# Integration tests

End-to-end tests of the running portal against real databases and real MCP servers. Only the language model is simulated: a scripted OpenAI-compatible mock (`mockLlm.ts`) answers chat and embedding requests and records every request, so the tests can check exactly what the portal sends to a provider.

```
tests ──HTTP──▶ portal (node --import tsx src/main.ts, started by globalSetup.ts)
                  ├──▶ portal-db        pgvector/pgvector:pg16   (fresh database per run)
                  ├──▶ mock LLM         in the test process      (chat completions + embeddings)
                  ├──▶ pg-mcp           tommi2day/pg-mcp-server      ──▶ pg-test      postgres:18-alpine   (static token)
                  ├──▶ pg-mcp-oauth     tommi2day/pg-mcp-server      ──▶ pg-test      (OAuth 2.0, tokens from keycloak)
                  ├──▶ keycloak         quay.io/keycloak/keycloak    realm "ai-portal" (client-credentials clients)
                  └──▶ oracle-mcp       tommi2day/oracle-mcp-server  ──▶ oracle-test  gvenzl/oracle-free:23-slim-faststart
```

## Run

```bash
docker compose -f docker-compose.test.yml up -d --wait     # from the repository root, ~30 s
cd server && npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

Without Oracle (saves ~2 GB RAM and the large image):

```bash
docker compose -f docker-compose.test.yml up -d --wait portal-db pg-mcp pg-mcp-oauth
IT_SKIP_ORACLE=1 npm run test:integration
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `IT_PORTAL_DB_URL` | `postgres://aiportal:aiportal@127.0.0.1:55433/aiportal` | Admin connection; each run creates and drops `aiportal_it_<timestamp>` |
| `IT_PG_MCP_URL` | `http://127.0.0.1:3101/mcp` | pg-mcp-server (token `it-pg-token`) |
| `IT_ORACLE_MCP_URL` | `http://127.0.0.1:3102/mcp` | oracle-mcp-server (token `it-oracle-token`) |
| `IT_PG_MCP_OAUTH_URL` | `http://127.0.0.1:3103/mcp` | pg-mcp-server with OAuth (Keycloak tokens, group `grp-pg`; break-glass token `it-pg-oauth-admin`) |
| `IT_KEYCLOAK_URL` | `http://127.0.0.1:8180/realms/ai-portal` | Keycloak realm as the host reaches it (clients `portal-it` in `grp-pg`, `portal-denied` outside; secrets `<client>-secret`) |
| `IT_SKIP_ORACLE` | – | `1` skips the Oracle tests |
| `IT_KEEP_DB` | – | `1` keeps the test database for inspection |
| `IT_SHOW_LOG` | – | `1` prints the last portal log lines after the run |
| `PG_MCP_TAG`, `ORACLE_MCP_TAG` | `latest` | Image tags of the MCP servers (compose) |
| `PG_MCP_OAUTH_TAG` | `1.1.0` | pg-mcp-server image for the OAuth instance (OAuth needs ≥ 1.1.0; an older cached `latest` has no OAuth) |

The host ports can be changed with `IT_PORTAL_DB_PORT`, `IT_PG_MCP_PORT`, `IT_PG_MCP_OAUTH_PORT`, `IT_KEYCLOAK_PORT` and `IT_ORACLE_MCP_PORT` (compose) together with the URLs above.

## What is covered

| File | Scope |
| --- | --- |
| `mcp.it.test.ts` | Per-user MCP servers: encrypted headers, connection test, wrong token, isolation between users, tool prefixes and schemas offered to the model, full tool loop portal → model → pg-mcp-server / oracle-mcp-server → database → answer, read-only violation passed back to the model and audited as failed, parallel calls to both servers, "MCP tools" switch, unreachable server |
| `mcp-oauth.it.test.ts` | pg-mcp-server **with and without OAuth** against a real Keycloak: token claims (groups, audience), 401 + protected-resource metadata, plain server rejects OAuth tokens; portal MCP servers with OAuth client credentials (token fetched by the portal, write-only secret, tool loop down to PostgreSQL, OAuth replaces a static `Authorization` header, break-glass token, wrong secret, client outside the allowed group, no credentials); the portal's own `/mcp` with Keycloak access tokens (known / unknown / deactivated SSO user, metadata, audited denials) |
| `sso.it.test.ts` | SSO sign-in with a real Keycloak, the full browser round trip (portal → login form → callback, authorization code + PKCE, ID token validation): account provisioning from the claims, admin by group (`OIDC_ADMIN_GROUPS`), allow list and admin assignments from the admin UI, role following the identity provider, wrong password. Realm users: `alice` (`grp-pg`), `bob` (`grp-other`), `root` (`grp-admin`), password = user name; client `ai-portal-web` |
| *(knowledge.it.test.ts, updates)* | against the real web server: incremental update keeps what is reported unchanged, full replace overwrites every page and removes vanished subpages, an unreadable source keeps its content, external trigger with the source token (wrong/missing token, `replace` per call, audit, revoke) |
| `chat.it.test.ts` | Provider request: model ID, streaming, Bearer key, system prompt, complete history, attachment text, images only for image models; keys write-only, key rotation and base-URL change without restart; provider errors and `chat.error`; disabled providers; single default model; 401/403/CSRF, private chats, failed sign-ins |
| `knowledge.it.test.ts` | Embedding model test on save, Anthropic refused; upload, re-upload, hybrid search (exact terms and similarity), group and public collections; file-share sync (recursive, links, unchanged skip, changes, deletions, path confinement); the knowledge tool in the chat with audit; the `/mcp` endpoint with personal tokens and revocation |
| *(knowledge.it.test.ts, web source)* | `http` source against a real web server in the test process: header auth, subpages, start-path scope, `includeSubpages`/`maxDepth`, unchanged/changed/removed pages |
| `web.it.test.ts` | Branded `index.html` on all UI routes, CSP `img-src` for an external logo, static assets, `/api` 404, `/healthz`, `/readyz` |

Test files run one after another against the same portal instance; each file creates its own users, providers and chats.
