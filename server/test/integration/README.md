# Integration tests

End-to-end tests of the running portal against real databases and real MCP servers. Only the language model is simulated: a scripted OpenAI-compatible mock (`mockLlm.ts`) answers chat and embedding requests and records every request, so the tests can check exactly what the portal sends to a provider.

```
tests ──HTTP──▶ portal (node --import tsx src/main.ts, started by globalSetup.ts)
                  ├──▶ portal-db        pgvector/pgvector:pg16   (fresh database per run)
                  ├──▶ mock LLM         in the test process      (chat completions + embeddings)
                  ├──▶ pg-mcp           tommi2day/pg-mcp-server      ──▶ pg-test      postgres:18-alpine
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
docker compose -f docker-compose.test.yml up -d --wait portal-db pg-mcp
IT_SKIP_ORACLE=1 npm run test:integration
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `IT_PORTAL_DB_URL` | `postgres://aiportal:aiportal@127.0.0.1:55433/aiportal` | Admin connection; each run creates and drops `aiportal_it_<timestamp>` |
| `IT_PG_MCP_URL` | `http://127.0.0.1:3101/mcp` | pg-mcp-server (token `it-pg-token`) |
| `IT_ORACLE_MCP_URL` | `http://127.0.0.1:3102/mcp` | oracle-mcp-server (token `it-oracle-token`) |
| `IT_SKIP_ORACLE` | – | `1` skips the Oracle tests |
| `IT_KEEP_DB` | – | `1` keeps the test database for inspection |
| `IT_SHOW_LOG` | – | `1` prints the last portal log lines after the run |
| `PG_MCP_TAG`, `ORACLE_MCP_TAG` | `latest` | Image tags of the MCP servers (compose) |

The host ports can be changed with `IT_PORTAL_DB_PORT`, `IT_PG_MCP_PORT` and `IT_ORACLE_MCP_PORT` (compose) together with the URLs above.

## What is covered

| File | Scope |
| --- | --- |
| `mcp.it.test.ts` | Per-user MCP servers: encrypted headers, connection test, wrong token, isolation between users, tool prefixes and schemas offered to the model, full tool loop portal → model → pg-mcp-server / oracle-mcp-server → database → answer, read-only violation passed back to the model and audited as failed, parallel calls to both servers, "MCP tools" switch, unreachable server |
| `chat.it.test.ts` | Provider request: model ID, streaming, Bearer key, system prompt, complete history, attachment text, images only for image models; keys write-only, key rotation and base-URL change without restart; provider errors and `chat.error`; disabled providers; single default model; 401/403/CSRF, private chats, failed sign-ins |
| `knowledge.it.test.ts` | Embedding model test on save, Anthropic refused; upload, re-upload, hybrid search (exact terms and similarity), group and public collections; file-share sync (recursive, links, unchanged skip, changes, deletions, path confinement); the knowledge tool in the chat with audit; the `/mcp` endpoint with personal tokens and revocation |
| `web.it.test.ts` | Branded `index.html` on all UI routes, CSP `img-src` for an external logo, static assets, `/api` 404, `/healthz`, `/readyz` |

Test files run one after another against the same portal instance; each file creates its own users, providers and chats.
