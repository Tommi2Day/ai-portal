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

## Docker Compose

```bash
cp .env.example .env      # fill in the secrets above
docker compose up --build
```

The compose file starts `pgvector/pgvector:pg16` and the app on port 8080. File shares for the knowledge base can be mounted read-only under `./shares` (mapped to `/data/shares`).

## Kubernetes

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

## Health, logs and monitoring

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | Process is alive (liveness) |
| `GET /readyz` | Database reachable (readiness) |

Logs are JSON lines on stdout (pino). Audit events carry `"audit": true` and can be routed to a separate index or stream. Useful alerts: `level >= 50` (errors), `action = knowledge.sync` with `success = false`, spikes of `auth.login_failed` or `token.auth_failed`.

## Backups

- PostgreSQL: regular dumps or the operator's backup feature (CloudNativePG: `ScheduledBackup`). The database contains chats, attachments, the knowledge base text and the audit log.
- `ENCRYPTION_KEY`: store separately (password vault). A database backup without this key cannot decrypt stored credentials.
- The knowledge base can always be rebuilt from its sources; uploads into collections exist only in the database.

## Upgrades

1. Build or pull the new image.
2. Roll out (`kubectl rollout` / `docker compose up -d`). Migrations run on start.
3. Check `/readyz` and the logs.

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
