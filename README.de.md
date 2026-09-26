# AI Portal

Die Oberfläche ist auf **Deutsch und Englisch** verfügbar (Umschalter DE | EN oben rechts und auf der Anmeldeseite; Standard ist die Browsersprache).

> English documentation: [README.md](README.md) · [docs/](docs/)

Interne Web-Anwendung für KI-Chat mit Benutzerverwaltung (lokal, LDAP/AD, OIDC/Azure AD), zentral verwalteten KI-Anbietern (Anthropic Claude, AWS Bedrock, GitHub Models/Enterprise, OpenAI-kompatibel), MCP-Servern pro Benutzer, Datei-Uploads und Audit-Log.

```
server/   Node.js 22 · Express 5 · Drizzle/PostgreSQL · Vercel AI SDK · MCP-SDK
web/      React 19 · Vite
deploy/   Kubernetes-Manifeste (kustomize)
```

## Schnellstart (Docker Compose)

```bash
cp .env.example .env
# SESSION_SECRET, ENCRYPTION_KEY (openssl rand -base64 32) und BOOTSTRAP_ADMIN_PASSWORD setzen
docker compose up --build
```

Dann http://localhost:8080 öffnen, als `admin` anmelden und unter **Administration → Anbieter & Modelle**:

1. Anbieter anlegen (z. B. *Anthropic Claude* mit API-Schlüssel).
2. Modelle freigeben (Vorlagen stehen zur Auswahl) und eines als Standard markieren.

Benutzer tragen ihre MCP-Server unter **MCP-Server** selbst ein (URL, optional `Authorization`-Header) und testen die Verbindung.

## Entwicklung

```bash
# Postgres lokal starten, dann:
cd server && npm ci && npm run dev      # API auf :8080, Migrationen laufen beim Start
cd web && npm ci && npm run dev         # UI auf :5173 mit Proxy auf /api
```

Schemaänderungen: `server/src/db/schema.ts` anpassen, dann `npm run db:generate` (erzeugt SQL unter `server/drizzle/`).

## Kubernetes

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n ai-portal create secret generic ai-portal \
  --from-literal=DATABASE_URL=postgres://aiportal:...@ai-portal-db-rw:5432/aiportal \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=ENCRYPTION_KEY=$(openssl rand -base64 32) \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='...'
# configmap.yaml, ingress.yaml und das Image in kustomization.yaml anpassen
kubectl apply -k deploy/k8s
```

Postgres: vorhandene Datenbank nutzen oder `postgres-cnpg.yaml` (CloudNativePG) aktivieren. Die App ist zustandslos und skaliert horizontal (HPA 2–6 Pods).

**ENCRYPTION_KEY sicher aufbewahren** – ohne ihn sind gespeicherte API-Schlüssel und MCP-Zugangsdaten nicht mehr lesbar.

## Anmeldung konfigurieren

| Methode | Variablen | Hinweise |
| --- | --- | --- |
| Lokal | `AUTH_LOCAL_ENABLED`, `BOOTSTRAP_ADMIN_*` | Admin wird nur angelegt, wenn noch kein Benutzer existiert |
| LDAP / AD | `LDAP_*` | Service-Bind → Suche → Bind als Benutzer. `LDAP_ADMIN_GROUP_DN` vergibt Admin-Rolle, `LDAP_USER_GROUP_DN` beschränkt Zugang. Für AD: `(sAMAccountName={{username}})` |
| OIDC / Azure AD | `OIDC_*` | Authorization Code + PKCE. Redirect-URI: `<PUBLIC_URL>/api/auth/oidc/callback`. App-Rollen `AiPortal.User` / `AiPortal.Admin` im Claim `roles` |

Externe Benutzer werden bei der ersten Anmeldung angelegt. Ist keine Admin-Gruppe/-Rolle konfiguriert, verwalten Admins die Rolle im Portal.

## Wissensdatenbank (RAG)

Interne Dokumente werden in **Sammlungen** indiziert und im Chat über das Tool `wissensdatenbank_suchen` durchsucht. Antworten enthalten nummerierte Quellen mit Links.

**Nur Text, keine Originale:** Von jedem Dokument wird ausschließlich der extrahierte Text gespeichert; die Originaldatei wird nach der Extraktion verworfen. Treffer verlinken auf die Quelle (Confluence-Seite, SharePoint-Datei, bei Dateifreigaben über das konfigurierbare Link-Präfix). Hochgeladene Dateien haben keine Quelle – dort führt der Link auf eine Textfassung (`/api/knowledge/documents/:id/open`).

1. **Administration → Wissensdatenbank → Embedding-Modell** wählen (Bedrock Titan/Cohere, GitHub Models oder OpenAI-kompatibel – z. B. BGE-M3 lokal über Ollama/TEI). Anthropic bietet keine Embeddings.
2. Sammlung anlegen und freigeben: für alle, für Gruppen (LDAP-Gruppen-CN, OIDC-Claim `groups`/`roles`, bei lokalen Benutzern im Portal gepflegt) oder nur Admins.
3. Quellen hinzufügen:

| Quelle | Konfiguration | Zugang |
| --- | --- | --- |
| Upload | Dateien direkt in die Sammlung laden | – |
| Dateifreigabe | Pfad unter `KNOWLEDGE_FS_ROOT` (SMB/NFS in den Pod gemountet, siehe `deploy/k8s/share-smb.yaml`) | Mount-Rechte |
| Confluence Cloud | `https://firma.atlassian.net/wiki`, Space-Keys | E-Mail + API-Token (REST v2) |
| Confluence Server/DC | Basis-URL, Space-Keys | Personal Access Token (REST v1) |
| SharePoint / OneDrive | Tenant, App-ID, Site-URL oder UPN, optional Bibliothek/Ordner | Entra-App mit `Sites.Selected` (empfohlen) oder `Sites.Read.All`/`Files.Read.All`, Client-Secret |

Formate: PDF, DOCX, PPTX, XLSX, HTML, Markdown, Text, Code, CSV/JSON/YAML/XML. Gescannte PDFs ohne Textebene werden übersprungen (OCR fehlt).

Technik: pgvector (HNSW-Index je Dimension) + PostgreSQL-Volltext, kombiniert per Reciprocal Rank Fusion. Synchronisierung inkrementell (Version/eTag/mtime), gelöschte Dokumente werden entfernt, Wechsel des Embedding-Modells stößt automatisch eine Neuindizierung an. Mehrere Pods synchronisieren nie dieselbe Quelle gleichzeitig (Advisory Locks).

**Voraussetzung:** PostgreSQL mit pgvector (`pgvector/pgvector:pg16` im Compose-Setup). Die Migration führt `CREATE EXTENSION vector` aus – fehlen dem DB-Benutzer die Rechte, die Erweiterung einmalig als Admin anlegen.

### Wissensdatenbank als MCP-Server

Unter `<PUBLIC_URL>/mcp` (Streamable HTTP, zustandslos) steht die Wissensdatenbank externen MCP-Clients zur Verfügung – mit den Rechten des Benutzers, dem das Token gehört. Tokens erstellt jede Person selbst unter **MCP-Server → Zugriffstokens** (30/90/365 Tage, widerrufbar, gespeichert nur als SHA-256).

Tools: `sammlungen_auflisten`, `wissensdatenbank_suchen` (query, sammlung?, anzahl?), `dokument_lesen` (dokument_id).

LibreChat (`librechat.yaml`):

```yaml
mcpServers:
  ai-knowledge:
    type: streamable-http
    url: https://ai.firma.local/mcp
    headers:
      Authorization: "Bearer {{AI_PORTAL_TOKEN}}"
    customUserVars:
      AI_PORTAL_TOKEN:
        title: "AI Portal Zugriffstoken"
        description: "Im AI Portal unter MCP-Server → Zugriffstokens erstellen"
```

Claude Desktop / andere stdio-Clients: `npx -y mcp-remote https://ai.firma.local/mcp --header "Authorization:Bearer ${TOKEN}"`.

Jeder Aufruf wird auditiert (`knowledge.search`, `knowledge.document.read` mit `via: mcp`, fehlgeschlagene Anmeldungen als `token.auth_failed`). Limit: 120 Anfragen pro Minute und IP.

## Audit-Log

Jede sicherheitsrelevante Aktion wird doppelt geschrieben (Einträge immer auf Englisch, unabhängig von der Sprache der Oberfläche): in die Tabelle `audit_log` (Ansicht, Filter und CSV-Export unter **Administration → Audit-Log**) und als JSON-Zeile mit `"audit":true` auf stdout für Loki/ELK/Splunk.

Erfasst: An-/Abmeldung (auch fehlgeschlagen), Benutzer-, Anbieter-, Modell- und MCP-Änderungen, jeder Prompt (Modell, Länge, Anhänge; Volltext nur mit `AUDIT_LOG_PROMPTS=true`), jede Antwort (Tokens, Dauer, Tool-Aufrufe), jeder MCP-Tool-Aufruf, jede Wissenssuche (Sammlungen, Trefferzahl, gefundene Dokumente), jede Synchronisierung, Datei-Upload/-Download, Audit-Export.

## API (Auszug)

| Methode | Pfad | Zweck |
| --- | --- | --- |
| POST | `/api/auth/login` | `{username, password, method: local\|ldap}` |
| GET | `/api/auth/oidc/start` | SSO-Anmeldung starten |
| GET | `/api/models` | Freigegebene Modelle |
| POST | `/api/chats/:id/messages` | Nachricht senden, Antwort als NDJSON-Stream |
| POST | `/api/files` | Upload (multipart, Feld `files`) |
| CRUD | `/api/mcp-servers` | Eigene MCP-Server, `POST /:id/test` |
| CRUD | `/api/admin/{users,providers,models}` | Administration |
| GET | `/api/admin/audit` | Audit-Log, `?format=csv` |

Schreibende Requests brauchen den Header `X-Requested-With: ai-portal` (CSRF-Schutz).
