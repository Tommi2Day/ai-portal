# AI Portal

[![CI](https://github.com/Tommi2Day/ai-portal/actions/workflows/ci.yml/badge.svg)](https://github.com/Tommi2Day/ai-portal/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Tommi2Day/ai-portal/graph/badge.svg)](https://codecov.io/gh/Tommi2Day/ai-portal)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/tommi2day/ai-portal)](https://github.com/Tommi2Day/ai-portal/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/tommi2day/ai-portal?logo=docker)](https://hub.docker.com/r/tommi2day/ai-portal)
[![License: MIT](https://img.shields.io/github/license/tommi2day/ai-portal)](LICENSE)

Die Oberfläche ist auf **Deutsch und Englisch** verfügbar (Umschalter DE | EN oben rechts und auf der Anmeldeseite; Standard ist die Browsersprache).

> English documentation: [README.md](README.md) · [docs/](docs/)

Interne Web-Anwendung für KI-Chat mit Benutzerverwaltung (lokal, LDAP/AD, OIDC/Azure AD), zentral verwalteten KI-Anbietern (Anthropic Claude, AWS Bedrock, GitHub Models/Enterprise, OpenAI-kompatibel), MCP-Servern pro Benutzer, Datei-Uploads und Audit-Log.

```
server/   Node.js 22 · Express 5 · Drizzle/PostgreSQL · Vercel AI SDK · MCP-SDK
web/      React 19 · Vite
deploy/   Kubernetes-Manifeste (kustomize)
```

## Screenshots

**Chat** – Antwort mit Treffern aus der Wissensdatenbank, MCP-Tool-Aufruf (Oracle-Datenbank) und Quellen:

![Chat mit Wissensdatenbank-Suche, MCP-Tool-Aufruf und Quellen](docs/images/chat.de.png)

<table>
  <tr>
    <td width="50%" valign="top"><b>MCP-Server und Zugriffstokens</b> – eigene MCP-Server je Benutzer; die Wissensdatenbank als MCP-Server für andere Tools<br><img src="docs/images/mcp.de.png" alt="MCP-Server und Zugriffstokens"></td>
    <td width="50%" valign="top"><b>Anbieter und Modelle</b> – KI-Anbieter und der Modellkatalog für die Benutzer<br><img src="docs/images/admin-providers.de.png" alt="Administration: Anbieter und Modelle"></td>
  </tr>
  <tr>
    <td valign="top"><b>Wissensdatenbank</b> – Embedding-Modell, Sammlungen mit Zugriffsgruppen, Quellen mit Sync-Status<br><img src="docs/images/admin-knowledge.de.png" alt="Administration: Wissensdatenbank"></td>
    <td valign="top"><b>Benutzer</b> – lokale, LDAP- und SSO-Benutzer mit Rollen und Gruppen<br><img src="docs/images/admin-users.de.png" alt="Administration: Benutzer"></td>
  </tr>
  <tr>
    <td valign="top"><b>Audit-Log</b> – Filter und CSV-Export<br><img src="docs/images/admin-audit.de.png" alt="Administration: Audit-Log"></td>
    <td valign="top"><b>Anmeldung</b> – lokal, LDAP und SSO; <a href="#branding">mit eigenem Logo und eigenen Farben</a><br><img src="docs/images/login.de.png" alt="Anmeldeseite"><br><img src="docs/images/branding-login.png" alt="Anmeldeseite mit Firmen-Branding"></td>
  </tr>
</table>

## Schnellstart (Docker Compose)

```bash
cp .env.example .env
# SESSION_SECRET, ENCRYPTION_KEY (openssl rand -base64 32) und BOOTSTRAP_ADMIN_PASSWORD setzen
docker compose up --build
```

Dann http://localhost:8080 öffnen, als `admin` anmelden und unter **Administration → Anbieter & Modelle**:

1. Anbieter anlegen (z. B. *Anthropic Claude* mit API-Schlüssel).
2. Modelle freigeben (Vorlagen stehen zur Auswahl) und eines als Standard markieren.

Details je Anbieter: [KI-Anbieter anbinden](#ki-anbieter-anbinden).

Benutzer tragen ihre MCP-Server unter **MCP-Server** selbst ein (URL, optional `Authorization`-Header) und testen die Verbindung.

## Entwicklung

```bash
# Postgres lokal starten, dann:
cd server && npm ci && npm run dev      # API auf :8080, Migrationen laufen beim Start
cd web && npm ci && npm run dev         # UI auf :5173 mit Proxy auf /api
```

Unit- und API-Tests (Vitest, ohne externe Datenbank: die API-Tests starten die echte App gegen ein In-Process-PostgreSQL – PGlite mit pgvector – und ein geskriptetes Mock-LLM; die Tests werden vorher typgeprüft):

```bash
cd server && npm test    # API (Anmeldung, Administration, Chat mit Tool-Aufrufen, Dateien, Wissensdatenbank Upload/Sync/Suche, MCP), Bedrock-Anmeldung, Connectoren, LDAP, Embeddings, Verschlüsselung, Chunking, SSRF-Schutz, i18n, Textextraktion
cd web && npm test       # Anmelde- und MCP-Seite, Chat-Stream, Modellauswahl, Brand-Komponente, UI-Übersetzungen
```

Integrationstests starten das Portal gegen echtes PostgreSQL/pgvector, [pg-mcp-server](https://github.com/Tommi2Day/pg-mcp-server) und [oracle-mcp-server](https://github.com/Tommi2Day/oracle-mcp-server) (mit Oracle Free) in Docker; das Modell ist ein geskripteter Mock – geprüft wird die ganze Kette Portal → Modell → MCP-Tool → Datenbank → Antwort, dazu Wissensdatenbank und Anbieter-Anfragen. Details: [server/test/integration](server/test/integration/README.md).

```bash
docker compose -f docker-compose.test.yml up -d --wait
cd server && npm run test:integration      # IT_SKIP_ORACLE=1 ohne die Oracle-Container
```

GitHub Actions (`.github/workflows/ci.yml`) führt bei jedem Push und Pull Request Unit-Tests mit Coverage (Upload zu Codecov), Audit, Übersetzungsprüfung und Build für `server/` und `web/`, die Integrationstests mit dem Docker-Stack und einen Docker-Image-Build aus.

Releases (`.github/workflows/release.yml`) veröffentlichen nach Unit- und Integrationstests das Image [`tommi2day/ai-portal`](https://hub.docker.com/r/tommi2day/ai-portal) auf Docker Hub: Tag `X.Y.Z` pushen (→ `:X.Y.Z`, `:X.Y`, `:X`, `:latest`, `:sha-<kurz>`) oder den Workflow manuell mit einer Version starten – er setzt sie vorher in beiden `package.json` und in `deploy/k8s/kustomization.yaml` auf `main`.

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

## Branding

Name, Logo und Farben lassen sich ohne Neubau des Images anpassen:

| Variable | Wirkung |
| --- | --- |
| `PORTAL_NAME` | Name in der Kopfzeile, auf der Anmeldeseite und im Browser-Tab (Standard `AI Portal`) |
| `PORTAL_LOGO` | Logo-Datei (`.svg`, `.png`, `.jpg`, `.gif`, `.webp`, wird eingebettet) oder `http(s)://`-URL |
| `PORTAL_THEME_CSS` | Stylesheet, das nach den eingebauten Styles geladen wird und die CSS-Variablen aus `web/src/styles.css` überschreibt |

![AI Portal mit Firmenlogo und -farben](docs/images/branding-chat.png)

Beispiel unter [`examples/branding/`](examples/branding); Docker Compose hängt `BRANDING_DIR` (Standard `./examples/branding`) unter `/branding` ein. Details und alle Variablen: [Konfiguration](docs/configuration.md#branding).

## KI-Anbieter anbinden

Anbieter und Modelle sind **keine Umgebungsvariablen**: Admins pflegen sie unter **Administration → Anbieter & Modelle**, die Zugangsdaten liegen AES-256-GCM-verschlüsselt (`ENCRYPTION_KEY`) in PostgreSQL. Alle Aufrufe laufen serverseitig über das [Vercel AI SDK](https://ai-sdk.dev); der Browser kennt nur die ID eines freigegebenen Modells, nie einen Schlüssel. Der SDK-Client wird pro Anfrage erzeugt – neue Schlüssel, deaktivierte Anbieter und neue Modelle wirken ohne Neustart ab der nächsten Nachricht.

| Typ | Aufgerufene API | Eintragen |
| --- | --- | --- |
| Anthropic Claude | Messages API `https://api.anthropic.com/v1/messages` | API-Schlüssel aus der Anthropic Console (eigener Schlüssel/Workspace fürs Portal). Basis-URL nur für ein Gateway, **inklusive** `/v1` |
| AWS Bedrock | Converse API `https://bedrock-runtime.<region>.amazonaws.com` | Region (Standard `eu-central-1`) und Anmeldung: IAM-Rolle des Portals (kurzlebige API-Keys, nichts gespeichert), Access Key + Secret eines IAM-Benutzers oder ein Bedrock-API-Key; optional eine zu übernehmende Rolle |
| GitHub Models / Enterprise | `https://models.github.ai/inference`, mit Organisation `…/orgs/<org>/inference` | Fine-grained Token mit **Models: read**; Organisation optional (Richtlinien und Abrechnung der Org) |
| OpenAI-kompatibel | `<Basis-URL>/chat/completions` bzw. `/embeddings` | Basis-URL (Teil vor `/chat/completions`) und optional API-Schlüssel (Bearer) |

**AWS Bedrock** im Detail:

- Anthropic-Modelle über ein regionsübergreifendes Inference-Profile aufrufen, die Modell-ID beginnt dann mit der Geografie, z. B. `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (Verarbeitung bleibt in EU-Regionen). Für Anthropic-Modelle muss im AWS-Konto einmalig das Use-Case-Formular in der Bedrock-Konsole ausgefüllt sein.
- **Modelle des Kontos:** Beim Freigeben eines Modells (und beim Embedding-Modell) listet die Oberfläche, was das AWS-Konto in der Region anbietet – Inferenzprofile, Modelle der Region, veraltete Modelle und fehlender Modellzugriff sind markiert. `BEDROCK_INFERENCE_PROFILE_PREFIXES=eu.` zeigt nur EU-Profile. Rechte dafür: `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles`, `bedrock:GetFoundationModelAvailability`.
- IAM-Rechte: `bedrock:InvokeModel` und `bedrock:InvokeModelWithResponseStream` auf `arn:aws:bedrock:*::foundation-model/*` (alle Regionen des Profils) und `arn:aws:bedrock:<region>:<konto>:inference-profile/eu.*` – Beispiel-Policy in [docs/llm-providers.md](docs/llm-providers.md#aws-bedrock).
- **IAM-Rolle (empfohlen):** Das Portal nimmt seine AWS-Identität aus der Credential-Chain (EKS Pod Identity, IRSA, Instanzprofil, `AWS_*`-Variablen), übernimmt optional eine weitere Rolle (AssumeRole, z. B. in einem Bedrock-Konto) und signiert daraus lokal kurzlebige Bedrock-API-Keys (`BEDROCK_TOKEN_TTL_SECONDS`, Standard 1 h), die es vor Ablauf selbst erneuert. Nichts wird gespeichert, kein Neustart für Rotation. Recht dafür zusätzlich: `bedrock:CallWithBearerToken`.

**OpenAI-kompatible Endpunkte** – Beispiele für die Basis-URL:

| Ziel | Basis-URL | Modell-ID |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | z. B. `gpt-4.1` |
| Azure OpenAI / AI Foundry | `https://<ressource>.openai.azure.com/openai/v1` | **Deployment-Name** |
| Ollama (lokal) | `http://ollama.firma.local:11434/v1` | z. B. `qwen3:32b`, Embeddings `bge-m3` |
| vLLM (lokal) | `http://vllm.firma.local:8000/v1` | Name des geladenen Modells; für Tools `--enable-auto-tool-choice --tool-call-parser …` |
| Text Embeddings Inference | `http://tei.firma.local:8080/v1` | z. B. `BAAI/bge-m3` (nur Embeddings) |
| LiteLLM-Proxy | `http://litellm.firma.local:4000/v1` | Modellname aus LiteLLM; bringt Budgets, Quoten, Fallbacks und weitere Anbieter |

**Modelle freigeben:** Anbieter wählen, optional eine Vorlage, Modell-ID und Anzeigename prüfen (Modell-IDs ändern sich bei den Anbietern). „Versteht Bilder“ nur ankreuzen, wenn das Modell Bildeingaben kann – sonst erhält es nur den Text der Anhänge. Die Modellauswahl im Chat zeigt *Anzeigename · Anbieter*; wichtige Hinweise gehören daher in den Anzeigenamen, z. B. `Qwen3 32B (lokal, vertrauliche Daten)`. Einen eigenen Verbindungstest gibt es für Chat-Modelle nicht: kurze Nachricht in einem neuen Chat senden; Fehler erscheinen im Chat und als `chat.error` im Audit-Log.

**Was an den Anbieter geht:** Systemprompt, der **gesamte** bisherige Chatverlauf inklusive Text früherer Anhänge, die neue Nachricht mit extrahiertem Anhangstext (Bilder nur bei „versteht Bilder“), die Tool-Definitionen der aktiven MCP-Server und der Wissenssuche sowie im Tool-Loop deren Ergebnisse (bis `MAX_TOOL_STEPS`, Standard 8 Runden). Folgen:

- Lange Chats und große Anhänge werden bei jeder Nachricht erneut gesendet – bei Überschreiten des Kontextfensters lehnt der Anbieter ab; für ein neues Thema einen neuen Chat beginnen.
- Modelle ohne Function Calling scheitern, sobald Tools mitgeschickt werden – im Anzeigenamen kennzeichnen und die Schalter *MCP-Tools* / *Wissensdatenbank* ausschalten.
- Beim Indexieren gehen alle Textabschnitte der Dokumente an den Embedding-Anbieter, bei jeder Suche die Suchanfrage. Für Dokumente, die das Haus nicht verlassen dürfen: lokales Embedding-Modell (Ollama, TEI) als OpenAI-kompatiblen Anbieter.

**Netzwerk:** Die Pods brauchen HTTPS zu den eingetragenen Endpunkten. Node.js ignoriert `HTTPS_PROXY`, solange nicht `NODE_USE_ENV_PROXY=1` gesetzt ist – dann gelten `HTTPS_PROXY`/`NO_PROXY` für alle ausgehenden `fetch`-Aufrufe (KI-Anbieter, Embeddings, MCP-Server). Bei TLS-Inspection oder interner CA `NODE_EXTRA_CA_CERTS` auf die gemountete CA-Datei setzen.

**Betrieb:** Schlüssel über „Schlüssel“ in der Anbieterzeile tauschen (wirkt ab der nächsten Nachricht). Achtung Bedrock: „Schlüssel“ ersetzt Access Keys durch einen Bedrock-API-Key; Access Keys per `PATCH /api/admin/providers/:id` mit `{"secret":{"accessKeyId":"…","secretAccessKey":"…"}}` rotieren. Basis-URL, Region und Organisation lassen sich nur per API ändern. Tokenverbrauch steht an jeder Antwort und im Audit-Eintrag `chat.completion`.

Ausführlich mit Fehlerbildern: [docs/llm-providers.md](docs/llm-providers.md) (englisch).

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

## Lizenz

[MIT](LICENSE). Abhängigkeiten von Drittanbietern behalten ihre eigenen Lizenzen.
