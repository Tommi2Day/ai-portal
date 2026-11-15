# Installation & operations

## Requirements

| Component | Version / note |
| --- | --- |
| Container runtime | Docker 24+ or Kubernetes 1.27+ |
| PostgreSQL | 16 with the **pgvector** extension (0.6+) |
| Outbound network | To the AI providers you configure, to LDAP / the OIDC issuer, to MCP servers and knowledge sources |
| Ingress | HTTPS termination; response buffering must be disabled for streaming |

The application is a single stateless image. All state lives in PostgreSQL, so any number of replicas can run behind a load balancer without sticky sessions or shared storage.

## Secrets you must generate

| Variable | How | Why it matters |
| --- | --- | --- |
| `SESSION_SECRET` | `openssl rand -hex 32` | Signs session cookies. Changing it signs everyone out. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | Encrypts provider keys, MCP headers and source credentials (AES-256-GCM). **Back it up separately from the database.** Without it, stored credentials cannot be decrypted. |
| `BOOTSTRAP_ADMIN_PASSWORD` | any strong password | Creates the first local admin — only if no user exists yet. |

## Other settings you will need

Every setting is an environment variable, listed with defaults in the [configuration reference](configuration.md) and in `.env.example`. These matter for every installation:

| Variable | Why |
| --- | --- |
| `PUBLIC_URL` | The address users and other systems reach the portal at (default `http://localhost:8080`). It is used for the OIDC redirect URI, links in MCP results and the webhook addresses shown in the admin UI, so set it correctly **before** the first sign-in with SSO |
| `COOKIE_SECURE` | `true` when the portal is served over HTTPS (it should be); with `true` on plain HTTP the session is lost immediately |
| `LOG_LEVEL` | `info` by default; prompts and answers are never logged unless `AUDIT_LOG_PROMPTS=true` |
| `MCP_ALLOW_PRIVATE_NETWORKS` | `true` by default so internal MCP servers work; set `false` in shared environments so users cannot make the portal call internal addresses |
| `KNOWLEDGE_ENABLED` | `false` switches off the knowledge base, its admin UI and the `/mcp` endpoint |
| `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | Outbound proxy and internal CA ([Connecting LLM providers](llm-providers.md#network-proxy-and-certificates)) |
| `LDAP_*`, `OIDC_*`, `MCP_OAUTH_*` | Sign-in methods and OAuth on `/mcp` ([configuration](configuration.md)) |

**Which values are secrets:** `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`, `LDAP_BIND_PASSWORD` and `OIDC_CLIENT_SECRET` belong into the Kubernetes secret (see `deploy/k8s/secret.example.yaml`) or into `.env`, never into the ConfigMap or the repository. All replicas must use the **same** `SESSION_SECRET` and `ENCRYPTION_KEY`.

## Docker Compose

```bash
cp .env.example .env      # fill in the secrets above
docker compose up --build
```

The compose file starts `pgvector/pgvector:pg16` and the app on port 8080. File shares for the knowledge base can be mounted read-only under `./shares` (mapped to `/data/shares`).

### Using the published image

Instead of building, use the image from Docker Hub, [`tommi2day/ai-portal`](https://hub.docker.com/r/tommi2day/ai-portal), or its mirror on GitHub Container Registry, `ghcr.io/tommi2day/ai-portal` (same tags, no pull rate limit). Tags: `X.Y.Z` (exact release), `X.Y` and `X` (latest of that line), `latest`, and `sha-<short>` for every build. **Pin a version in production** (`image: tommi2day/ai-portal:X.Y.Z`) and read the [CHANGELOG](../CHANGELOG.md) before upgrading. A compose file with the published image and a database is in the [Docker Hub description](../DOCKERHUB.md#quick-start).

## Kubernetes

### Helm

The chart in `helm/ai-portal` is published to `oci://ghcr.io/tommi2day/charts` with every release. Secrets (`SESSION_SECRET`, `ENCRYPTION_KEY`, admin password) are generated on first install and kept on upgrade; use `existingSecret` to manage them yourself.

```bash
helm install ai-portal oci://ghcr.io/tommi2day/charts/ai-portal --version 1.0.0 -n ai-portal --create-namespace \
  --set config.PUBLIC_URL=https://ai.example.com \
  --set secret.databaseUrl='postgres://aiportal:…@db:5432/aiportal' \
  --set ingress.enabled=true --set ingress.hosts[0].host=ai.example.com --set ingress.hosts[0].paths[0].path=/
# or let the CloudNativePG operator provide PostgreSQL + pgvector: --set cnpg.enabled=true
```

To use **Traefik** instead of an nginx ingress, render a Traefik `IngressRoute` (Traefik v3 or v2 with its CRDs installed; set `traefik.apiVersion: traefik.containo.us/v1alpha1` for v2):

```bash
helm install ai-portal … --set ingress.enabled=false \
  --set traefik.enabled=true --set traefik.hosts[0]=ai.example.com \
  --set traefik.tls.certResolver=letsencrypt      # or traefik.tls.secretName=<tls secret>
```

The route listens on the `websecure` entry point and a second route on `web` redirects to HTTPS (`traefik.redirectHttp`). Traefik neither buffers streaming answers nor limits the body size, so the nginx annotations are not needed. A plain `Ingress` with `ingress.className=traefik` also works.

All options are documented in `helm/ai-portal/values.yaml`. Back up `ENCRYPTION_KEY` from the generated secret.

### Kustomize

Manifests live in `deploy/k8s/` and are assembled with kustomize.

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n ai-portal create secret generic ai-portal \
  --from-literal=DATABASE_URL='postgres://aiportal:…@ai-portal-db-rw:5432/aiportal' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='…'
# adjust configmap.yaml, ingress.yaml and the image in kustomization.yaml
kubectl apply -k deploy/k8s
```

| Manifest | Purpose |
| --- | --- |
| `deployment.yaml` | 2 replicas, zero-downtime rolling updates, probes, non-root, read-only root file system |
| `configmap.yaml` | Non-secret settings |
| `secret.example.yaml` | Template for secrets — prefer External Secrets, Sealed Secrets or Vault |
| `service.yaml`, `ingress.yaml` | HTTP service; nginx ingress with buffering off, 600 s read timeout, 25 MB body, TLS via cert-manager |
| `hpa.yaml`, `pdb.yaml` | Autoscaling 2–6 pods at 70 % CPU; at least one pod during disruptions |
| `networkpolicy.yaml` | Only the ingress controller may reach the pods |
| `share-smb.yaml` | Optional SMB share for the knowledge base (SMB CSI driver) |
| `postgres-cnpg.yaml` | Optional PostgreSQL cluster via the CloudNativePG operator, including `CREATE EXTENSION vector` |

Other ingress controllers need the equivalent of: no response buffering on `/api/chats/*/messages`, read timeout of several minutes, request body ≥ upload limit.

## Docker Compose with Traefik and Keycloak

`docker-compose.support.yaml` adds two supporting services, both routed by Traefik through labels (the portal's own labels and its OIDC settings are in `docker-compose.yml`):

- **[Traefik](https://traefik.io)** in front of the portal: TLS termination, HTTP → HTTPS redirect, no published portal port.
- **[Keycloak](https://www.keycloak.org)** as OIDC provider at `https://<KEYCLOAK_HOST>`, with the realm `ai-portal` imported once from `deploy/keycloak/ai-portal-realm.json`: client `ai-portal` (authorization code + PKCE), groups `ai-portal-admins` (portal admins) and `ai-portal-users`.

```bash
# .env (git-ignored): never commit it
#   PORTAL_HOST=ai.example.com            KEYCLOAK_HOST=auth.example.com
#   PUBLIC_URL=https://ai.example.com     COOKIE_SECURE=true     OIDC_ENABLED=true
#   KEYCLOAK_ADMIN_PASSWORD=<strong password>
#   OIDC_CLIENT_SECRET=<openssl rand -hex 32>
docker compose -f docker-compose.yml -f docker-compose.support.yaml up -d
```

Both host names must resolve to the Docker host. Create users with the helper script (or in `https://<KEYCLOAK_HOST>/admin`) (realm `ai-portal`, sign in as `admin`) and add them to a group; users in `ai-portal-admins` become portal admins on sign-in, every Keycloak user may sign in (restrict further with `OIDC_ALLOWED_GROUPS`, see [Administration](administration.md)).

```bash
scripts/keycloak-user.sh add alice alice@example.com --name "Alice Example"           # group ai-portal-users
scripts/keycloak-user.sh add root  root@example.com  --name "Root Admin" --admin      # portal admin
scripts/keycloak-user.sh passwd alice      # new one-time password;  also: list, delete <user>, secret
```

The script talks to the Keycloak admin API with `KEYCLOAK_ADMIN_PASSWORD` from `.env` (or asks for it), prints a generated one-time password once (`--permanent` skips the forced change) and stores nothing. First and last name are required because Keycloak's user profile insists on them. `scripts/keycloak-user.sh secret` pushes `OIDC_CLIENT_SECRET` from `.env` into the Keycloak client after you changed it there (the realm import runs only once); then recreate the stack (`docker compose … up -d`) so the portal picks up the new value. With an internal CA the script reads `OIDC_CA_FILE` from `.env`; `CURL_OPTS` passes extra curl options.

**Groups and applications:** `scripts/keycloak-oidc.sh` maintains the groups (they end up in the `groups` claim the portal reads for `OIDC_ADMIN_GROUPS`, `OIDC_ALLOWED_GROUPS` and group-based knowledge access) and further OIDC applications (Keycloak clients) in the realm:

```bash
scripts/keycloak-oidc.sh group add engineering
scripts/keycloak-oidc.sh group join engineering alice          # also: list, members, leave, delete
scripts/keycloak-oidc.sh app add wiki --name "Team Wiki" --redirect https://wiki.example.com/cb --audience api://wiki
scripts/keycloak-oidc.sh app add reports-mcp --service-account --sa-group engineering --audience api://reports   # client credentials
scripts/keycloak-oidc.sh app add spa --public --redirect https://spa.example.com/                                # PKCE only, no secret
scripts/keycloak-oidc.sh app redirects wiki https://wiki.example.com/cb https://wiki.example.com/cb2            # also: list, show, secret, delete
```

New applications use the authorization code flow with PKCE (S256) and no password grant; the generated client secret is printed once. A service account (`--service-account`) is for services that call the portal's APIs or that the portal calls with OAuth client credentials (MCP servers, see [Administration](administration.md)); `--sa-group` makes its token carry a group. The built-in clients and the portal's own client `ai-portal` are protected (changes need `--force`), as are the groups `ai-portal-admins` and `ai-portal-users`. The shared connection logic is in `scripts/keycloak-lib.sh`. The portal reaches Keycloak through Traefik under the same public host name (network alias), so OIDC discovery needs a certificate it trusts.

**Certificates:** `TRAEFIK_ACME_EMAIL` + `TRAEFIK_CERTRESOLVER=le` obtains Let's Encrypt certificates (port 80 must be reachable from the internet). For your own certificate put `tls.crt` (full chain) and `tls.key` into `./certs` (`TRAEFIK_CERTS_DIR`, git-ignored; `deploy/traefik/tls.yml` loads them); if an internal CA signed it, also put its `ca.crt` there and set `OIDC_CA_FILE=/certs/ca.crt` so the portal trusts it. Without any of these Traefik serves a self-signed certificate and the portal rejects it (SSO fails).

**Secrets:** the realm file contains only placeholders; the client secret and redirect URL come from `.env` at import time. The import runs once, so changing `OIDC_CLIENT_SECRET` later means changing it in Keycloak too (`scripts/keycloak-user.sh secret`). Keycloak uses its built-in file database in a volume; for production configure a real database (`KC_DB_*`, see the Keycloak documentation). `TRAEFIK_HTTP_PORT` / `TRAEFIK_HTTPS_PORT` change the host ports (keep 80/443 in production: the issuer URL and redirects assume them). Needs Docker Compose 2.24 or newer.

For another provider (Entra ID, ...) set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` in `.env`; they override the Keycloak defaults.

### Reverse proxy requirements

- **Client IP:** the portal trusts exactly **one** proxy hop (`X-Forwarded-For` of the proxy directly in front of it). Sign-in and API rate limits, the audit log and the webhook limit work per client IP; with two or more proxy hops in a row the IP of the first proxy would be used for everybody, so terminate in one hop or make sure the last proxy sets the real client address.
- **Paths to expose:** everything under `/` goes to the portal. Besides the web UI and `/api`, external systems use `/mcp` (knowledge base for MCP clients) and `/.well-known/oauth-protected-resource` (OAuth discovery) and `/api/hooks/knowledge/…` (update webhook). Do not block or rewrite them; do not add authentication in front of them, they carry their own tokens.
- **Headers:** the portal sets its own security headers (`helmet`, Content-Security-Policy); keep `X-Requested-With` on API calls (a proxy that strips it causes `csrf` errors).
- **Timeouts and buffering:** streaming chat answers need buffering off and a read timeout of several minutes; MCP calls and uploads follow the body limit above.

## First start

1. Start the application. Migrations run automatically; wait until `GET /readyz` answers.
2. Open `PUBLIC_URL` and sign in as `BOOTSTRAP_ADMIN_USER` (default `admin`) with `BOOTSTRAP_ADMIN_PASSWORD`. The account is created only if the database has no user yet; change the password afterwards.
3. Follow the [first steps in the administration guide](administration.md#first-steps): provider and model, sign-in methods, optional knowledge base.

## Database

- Migrations in `server/drizzle/` run automatically on every start (safe with several replicas starting at once: an advisory lock serializes them).
- Migration `0001` executes `CREATE EXTENSION IF NOT EXISTS vector`. If the application role may not create extensions, run that statement once as a database admin before the first start.
- Vector indexes (HNSW) are created at runtime, one per embedding dimension in use.

## File shares for the knowledge base

File-share sources read from a directory below `KNOWLEDGE_FS_ROOT` (default `/data/shares`). Mount shares read-only there:

- **Kubernetes:** see `deploy/k8s/share-smb.yaml` (PersistentVolume with the SMB CSI driver) and the commented volume in `deployment.yaml`.
- **Docker:** mount the share on the host and bind it into the container (`./shares:/data/shares:ro`).

Paths outside `KNOWLEDGE_FS_ROOT` are rejected.

## Background sync

Every pod runs the knowledge sync scheduler unless `KNOWLEDGE_WORKER=false`. PostgreSQL advisory locks guarantee that a source is synced by one pod at a time. To separate web traffic from indexing, run one extra deployment with `KNOWLEDGE_WORKER=true` and set it to `false` on the web pods.

### External trigger (webhook)

Sources set to *Triggered externally* are updated when another system calls `POST <PUBLIC_URL>/api/hooks/knowledge/<source id>/sync` with the source's token (see [Administration](administration.md#3-sources)). The path must be reachable from that system through your ingress or reverse proxy, and `PUBLIC_URL` must be the address that system uses, because the admin UI shows exactly this URL. The endpoint needs no session and no CSRF header; it is limited to 60 requests per minute and IP. It starts the update on the pod that receives the call; advisory locks still keep one update per source.

## Health, logs and monitoring

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | Process is alive (liveness) |
| `GET /readyz` | Database reachable (readiness) |

Logs are JSON lines on stdout (pino). Audit events carry `"audit": true` and can be routed to a separate index or stream. Useful alerts: `level >= 50` (errors), `action = knowledge.sync` with `success = false`, spikes of `auth.login_failed`, `token.auth_failed` or `knowledge.trigger_failed` (wrong webhook tokens). Credentials, bearer tokens, JWTs and URL passwords are masked in every log record and audit entry; errors of provider SDKs are reduced to type, message and status, so prompts and request headers do not end up in the logs. `LOG_LEVEL` sets the verbosity.

## Data growth and retention

Everything is stored in PostgreSQL and **nothing is deleted automatically**: chats and messages, chat attachments (as binary data, up to the upload limit per file), the audit log, and the knowledge base (extracted text, chunks and their vectors). Plan the database volume accordingly, watch its size, and agree on retention with your data protection officer; there is no built-in retention job for chats or audit entries, so use a scheduled SQL job if you need one. The knowledge base grows with the number and size of indexed documents and with the embedding dimension. Deleting a user removes their chats, files, MCP servers and tokens; the audit entries of that user remain.

## Backups

- PostgreSQL: regular dumps or the operator's backup feature (CloudNativePG: `ScheduledBackup`). The database contains chats, attachments, the knowledge base text and the audit log.
- `ENCRYPTION_KEY`: store separately (password vault). A database backup without this key cannot decrypt stored credentials.
- The knowledge base can always be rebuilt from its sources; uploads into collections exist only in the database.
- **Restore:** restore the dump into a PostgreSQL with the `vector` extension, start the application with the **same** `ENCRYPTION_KEY` (and `SESSION_SECRET` if sessions should survive), and check `/readyz`. Migrations bring an older dump up to date on start. Source credentials, provider keys and webhook tokens come back with the database; a wrong `ENCRYPTION_KEY` shows up as failing provider calls and source syncs.

## Upgrades

1. Back up the database, pull the new pinned tag (or build) and read the [CHANGELOG](../CHANGELOG.md) for changed settings.
2. Roll out (`kubectl rollout` / `docker compose up -d`). Migrations run on start.
3. Check `/readyz` and the logs.

Migrations since the first release add columns and enum values only (SSO/MCP OAuth settings, the `http` source type, update modes and webhook tokens, admin notes), so rolling back the image normally keeps working with the migrated database.

Rolling back across a migration that dropped a column is not automatic — take a database backup before upgrading.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Chat answers appear all at once instead of streaming | Ingress buffers responses — disable proxy buffering |
| `csrf` error on every action | A proxy strips the `X-Requested-With` header |
| Sign-in works, but the session is lost immediately | `COOKIE_SECURE=true` while the portal is served over plain HTTP |
| LDAP: "Client network socket disconnected before secure TLS connection" | `ldaps://` certificate not trusted — add the CA to the image or (test only) set `LDAP_TLS_REJECT_UNAUTHORIZED=false` |
| Knowledge base finds nothing after changing the embedding model | Re-indexing still running — watch the sources' status in the admin UI |
| `permission denied to create extension "vector"` on start | Create the extension once as a database admin |
| SSO sign-in ends with “SSO sign-in failed” | The redirect URI at the identity provider is not exactly `<PUBLIC_URL>/api/auth/oidc/callback`, the client secret is wrong, or the portal cannot reach the issuer (proxy or CA, see above); the log has the cause |
| SSO sign-in ends with “You are not authorized to use the AI Portal” | The user matches no *Access* entry or `OIDC_ALLOWED_*` / `OIDC_USER_VALUE` rule and is no admin ([Single sign-on assignments](administration.md#single-sign-on-assignments)) |
| MCP client gets `401` from `/mcp` with an OAuth token | The token's audience is not `MCP_OAUTH_AUDIENCE`, the issuer differs, or the person never signed in to the portal with SSO; the audit log shows `token.auth_failed` with the reason |
| Webhook call answers `401` | Wrong, revoked or replaced token, or the source id does not match; `409`: the source is disabled or an update is already running ([Administration](administration.md#3-sources)) |
| A web source fails with “redirect … outside the allowed area” | The site sends the crawler to a login page; add a request header or fix the URL |
| `/readyz` answers 503 | The database is not reachable; check `DATABASE_URL`, the network policy and the database |
| Stored credentials suddenly fail to decrypt | `ENCRYPTION_KEY` differs from the one used when they were stored (restore, or a changed secret) |
