# Administration guide

Everything in this guide is done in the web UI under **Administration** (visible to admins only). Labels refer to the English UI; switch the language with **DE | EN** in the top bar.

## First steps

After the [installation](installation.md#first-start) sign in with the bootstrap admin and work through this list:

1. **Add an AI provider** and **approve at least one model**, marked as default ([AI providers and models](#ai-providers-and-models)). Without a model nobody can chat.
2. **Choose how people sign in:** local accounts work out of the box; LDAP and OIDC/SSO are enabled through environment variables ([local](configuration.md#bootstrap-and-local-sign-in), [LDAP](configuration.md#ldap--active-directory), [OIDC](configuration.md#oidc-azure-ad--entra-id-keycloak-)), SSO access and admin rules are maintained under [Single sign-on assignments](#single-sign-on-assignments).
3. **Optional, for the knowledge base:** embedding model, a collection, a source ([Knowledge base](#knowledge-base)).
4. **Check the result:** ask a question in the chat as a normal user, then look at the [audit log](#audit-log).

## Users, roles and groups

**Tab “Users”**

- **Local users** are created here (username, display name, password ≥ 12 characters, role). Passwords can be reset via “Password”.
- **Self-registration** (optional, `REGISTRATION_ENABLED=true`): the login page offers “Register a new account” (full name, email, username, password). Such accounts are marked “Awaiting approval” and cannot sign in until you tick “Active”; delete the account to reject it.
- **LDAP and SSO users** are created automatically on their first sign-in. After that first sign-in they see a one-time “Complete your profile” page with full name and email prefilled from the directory. Values the directory provides are refreshed on every sign-in and overwrite manual edits; empty directory attributes never erase a stored value.
- **Roles:** *Admin* sees the administration area; *Users* use chat, MCP servers and the knowledge base. SSO access and admin assignments (group, e-mail, `*@domain`, object ID) are managed under **Administration → Single Sign-On**. If an admin group (LDAP) or an OIDC admin setting (`OIDC_ADMIN_VALUE`, `OIDC_ADMIN_GROUPS`, `OIDC_ADMIN_USERS`) is configured, the role is synced from the directory on every sign-in and manual changes are overwritten.
- **Groups** decide which knowledge collections a user can search. For local users, edit them via “change”; for LDAP/SSO users they come from the directory.
- **Deactivating** a user (“Active” unchecked) takes effect immediately — including personal access tokens.
- You cannot demote, deactivate or delete your own account.

## Single sign-on assignments

**Keycloak from the Compose setup:** users, groups and further OIDC applications of the bundled realm are maintained with `scripts/keycloak-user.sh` and `scripts/keycloak-oidc.sh` (see [Installation](installation.md#docker-compose-with-traefik-and-keycloak)); membership of the group `ai-portal-admins` makes a user portal admin on sign-in.

**Tab “Single Sign-On”.** It needs `OIDC_ENABLED=true`; otherwise the tab only shows a warning. It decides who may sign in through the identity provider and who becomes admin, on top of the `OIDC_*` settings ([configuration](configuration.md#oidc-azure-ad--entra-id-keycloak-)).

| Column | Meaning |
| --- | --- |
| Type | *Group* (name or object ID, compared with the group and role claims of the token) or *User* (e-mail, `*@example.com` or object ID) |
| Value | what is compared, case-insensitively |
| Role | *Admin*: matching users become admins at every sign-in. *Access*: matching users may sign in |
| Comment | a note for admins, no effect on access |

- Rows marked *Environment* come from `OIDC_ADMIN_GROUPS`, `OIDC_ADMIN_USERS`, `OIDC_ALLOWED_GROUPS` and `OIDC_ALLOWED_USERS` and are read-only here. All other rows are stored in the database, are active on every replica within seconds and are audited (`sso.assignments`).
- **Deny by default:** while no *Access* entry exists (neither here nor in `OIDC_ALLOWED_*` / `OIDC_USER_VALUE`), everyone the identity provider authenticates may sign in. As soon as one exists, only matching users and admins may. *Admin* entries alone restrict nobody.
- **Roles follow the identity provider:** once any admin rule exists, the role is set at every sign-in, so a person removed from the admin group becomes a normal user at their next sign-in.
- Changes apply at the user's **next SSO sign-in**. Open sessions stay valid until they expire; to cut access immediately, deactivate the user on the *Users* tab.
- Local and LDAP sign-in are not affected, so a local admin can always correct a wrong allow list.
- Prefer the **object ID** for admins: e-mail, `preferred_username` and `upn` are attributes some providers let users change. E-mails the provider marks as unverified are never used.
- The same rules apply to OAuth access tokens on `/mcp` ([security](security.md#oauth-and-sso-what-to-know)).

## AI providers and models

Details per provider type (IAM policy, base URLs, proxy, what is sent, troubleshooting): [Connecting LLM providers](llm-providers.md).

**Tab “Providers & models”**

1. **Add a provider** (“Add provider”):

   | Type | What to enter |
   | --- | --- |
   | Anthropic Claude | API key; optional base URL for a proxy or gateway |
   | AWS Bedrock | Region and authentication: IAM role of the portal (short-term API keys, nothing stored), access key ID + secret access key, or a Bedrock API key; optionally a role to assume |
   | GitHub Models / Enterprise | Token with `models:read`; optional organization (bills and applies policies to the org) |
   | OpenAI-compatible | Base URL (Azure OpenAI, vLLM, Ollama, LiteLLM, TEI, …) and API key |

   Keys are write-only. “Key” replaces a key; the old one is never shown.

   For Bedrock (IAM role or access keys) the model selection below lists the models of the AWS account — inference
   profiles, models in the region, legacy models and missing model access are marked; ↻ reloads the list. See
   [Connecting LLM providers](llm-providers.md#aws-bedrock).

2. **Approve models** (“Approve model”): pick the provider, optionally a preset, set model ID and display name, and tick “understands images” if the model accepts images. Presets are starting points — verify model IDs against the vendor's current catalog.
3. Mark exactly one model as **default**. Disable models or whole providers to remove them from the user selection immediately.
4. **Deleting** a model keeps existing chats (they only lose their model reference, the history stays readable); deleting a provider also deletes its models. To retire a model without losing the reference, disable it instead.

## Knowledge base

**Tab “Knowledge base”**

### 1. Embedding model

Choose the provider and model that turns text into vectors. Options:

| Choice | When |
| --- | --- |
| Local model via an OpenAI-compatible provider (e.g. BGE-M3 on Ollama or Text Embeddings Inference) | Documents must not leave the company; good multilingual quality |
| Amazon Titan Text Embeddings v2 or Cohere Embed Multilingual (Bedrock) | Bedrock is already in use |
| `text-embedding-3-small` via GitHub Models or OpenAI-compatible | Quick start |

Anthropic does not offer embedding models. “Save & test” probes the model. **Changing the model re-indexes every source automatically**; stored text is re-embedded, nothing is downloaded again.

### 2. Collections

A collection groups sources and defines who can search them:

- **for all signed-in users**,
- **for groups** — comma-separated group names (LDAP CN, OIDC values from the `groups`/`roles` claims, or groups of local users; case-insensitive),
- **admins only** — no groups and not public.

**Creating and managing collections:** *New collection* asks for a name, a description and the groups (comma-separated, or “for all signed-in users”). On the collection card: *Access* changes the groups later (enter `*` for all signed-in users, leave it empty for admins only), *Upload files* adds documents directly, *Add source* connects an external source, *Delete* removes the collection **with all its sources and documents** (after a confirmation).

Write a short description: the model sees it and uses it to decide where to search. Permissions apply per collection, not per document — put only content with the same audience into one collection.

### 3. Sources

| Source | Setup |
| --- | --- |
| Upload (“Upload files”) | Upload files directly into the collection. Only the extracted text is kept; the original is discarded. |
| File share | Path below the mount root (see [installation](installation.md#file-shares-for-the-knowledge-base)), optional link prefix so hits link to the file (e.g. `file://fileserver/it/` or an intranet URL), optional exclusions (`Archive, Drafts`) |
| Confluence Cloud | Base URL `https://<site>.atlassian.net/wiki`, space keys and/or page IDs, service account email + API token |
| Confluence Server / Data Center | Base URL, space keys and/or page IDs, personal access token |
| Web pages (HTTP) | One or more start URLs, optional request header (e.g. `Authorization: Bearer …`, stored encrypted); the crawler follows links to subpages (see below) |
| SharePoint / OneDrive | Tenant ID, app (client) ID, client secret, and either a site URL (`https://<tenant>.sharepoint.com/sites/IT`) or a user's UPN for OneDrive; optional library name and sub folder |

**Managing sources:** *Add source* creates a source (and starts its first sync), *Documents* lists what was indexed (status, author, last change, errors; single documents can be removed), *Delete* removes the source **with its documents** (after a confirmation), *Settings* opens the source's settings panel. The *Upload* source of a collection has *Re-index* instead of *Sync now*: it only re-embeds the stored texts, for example after an embedding model change.

**Settings panel of a source** (*Settings* on the source row):

- **Source active:** switching it off stops scheduled and external updates (the webhook answers 409) and marks the source *disabled* in the table. *Sync now* still works, and the documents stay searchable; to remove the content, delete the source or its documents. Use it to pause a source while its system is down or its credentials are being replaced.
- **Update mode and full replace:** see *Updating a source* below.
- **Credentials** (Confluence, SharePoint and web sources; file shares have none): stored credentials are never shown, only whether some are stored. The form **replaces the whole set**: Confluence Cloud e-mail + API token, Confluence Server/DC personal access token, SharePoint client secret, web pages a header name and value (*Remove credentials* deletes the headers). *Replace credentials* saves them for the next update, *Replace & sync* saves and starts an update at once, which is the quickest way to check that a fixed token works. The change is audited (`knowledge.source.update`, never the values).
- **Webhook** for externally triggered sources, see below.

**Subpages (Confluence):** a space import takes *all* pages of the space, subpages included. Two settings control this:

- *Page IDs with subpages* (`rootPageIds`): import a page tree instead of (or in addition to) whole spaces. The ID is the number in the page URL (`…/pages/123456/…`). The page and its descendants are imported; a page that is part of a space and of a tree is indexed once.
- *Import subpages* (`includeSubpages`, default on) and *Max. depth* (`maxDepth`, 1 = direct children, 0 = unlimited): with subpages off, page trees import only their root pages and spaces only their top-level pages. The depth applies to page trees.

**Web pages (HTTP):** the crawler starts at the start URLs and follows links to subpages. Settings: *Follow links to subpages* (`includeSubpages`, default on; off = only the start URLs), *Max. link depth* (`maxDepth`, default 3, 0 = unlimited), *Max. pages per sync* (`maxPages`, default 200, at most 5000), *Path prefix* and *Exclude*. Rules:

- Only pages on the same host below the path of a start URL are fetched (`https://wiki.example/it/` → everything under `/it/`); the path prefix can widen or narrow this. Links to other hosts, `mailto:`, images, stylesheets and scripts are ignored.
- HTML pages, plain text and supported documents (PDF, DOCX, PPTX, XLSX, Markdown, …) are indexed; navigation, footers and forms are removed from HTML. `<meta name="robots">` is honoured (`noindex`: page not indexed, `nofollow`: links not followed). Files larger than `KNOWLEDGE_MAX_FILE_MB` are skipped.
- Redirects are followed only inside the allowed area; a start URL that redirects elsewhere (typically a login page) fails the sync with a clear message. The configured header is sent only to the allowed host.
- Change detection uses `ETag` / `Last-Modified`, otherwise a hash of the text; pages that vanish or are no longer reachable within the limits are removed on the next sync.
- The site must be reachable without an interactive login: use a header (token, API key, session cookie) for protected sites.

**SharePoint app registration:** create an Entra ID app with the **application** permission `Sites.Selected` (recommended, then grant read access to the specific sites) or `Sites.Read.All` / `Files.Read.All`, grant admin consent, create a client secret.

**Updating a source:** how the content is kept current is chosen per source (*Update*, when creating the source or later in the source's *Settings* panel):

| Mode | When the source is updated |
| --- | --- |
| **Automatic** | every 15 minutes, hourly or daily (`syncIntervalMinutes`) |
| **Manual** | only when an admin clicks *Sync now* |
| **Triggered externally** | when another system calls the source's webhook: a CI job after a documentation build, a Confluence / Git webhook, a cron job on another host |

*Sync now* is always available, whatever the mode. The result column shows `+added ~updated =unchanged −removed ✕errors`. “Documents” lists indexed documents with status and errors; single documents can be removed.

**What an update replaces:** by default an update is *incremental*: new and changed documents are imported (change detection by version, modification time or ETag), unchanged ones are skipped, documents that disappeared from the source are removed. With **Replace the stored content completely on every update** (`replaceOnSync`) the update re-imports *every* document in place and overwrites the stored content, even if the source reports no change; this includes the subpages as configured for the source (Confluence page trees and subpage settings, linked pages of a web source). The button *Replace completely* in the source's *Settings* panel does this once, whatever the setting; the external trigger can ask for it per call.

- Stored content is replaced and documents that vanished are removed only after the source was read completely. A source that cannot be read (wrong credentials, network error, start page gone) keeps its previous content and shows the error.
- A full replace that finds *nothing at all* in a source that has documents is treated as an error and keeps the content (protection against a temporarily empty share or a wrong path). An incremental update follows the source, also to “empty”.
- Pages that left the source's scope (subpages switched off, depth reduced, moved or deleted) are removed by the next update in both modes.

**External trigger (webhook):** choose *Triggered externally* (or the source's *Settings* panel). The portal creates a token for this one source and shows it **once** (masked until you click *Show*; only a hash is stored). The other system then calls:

```bash
curl -X POST -H "Authorization: Bearer kt_…" https://ai.example.com/api/hooks/knowledge/<source id>/sync
# full replace for this call only
curl -X POST -H "Authorization: Bearer kt_…" -H "Content-Type: application/json" -d '{"replace": true}' https://ai.example.com/api/hooks/knowledge/<source id>/sync
```

The answer is `202` (`{"started": true, "replace": …}`); the update runs in the background. `401` for a missing, wrong or revoked token (the same answer for unknown sources), `409` if the source is disabled or an update is already running, `400` for uploads. The token can do nothing but start this source's update; *Create new token* replaces it (the old one stops working immediately), *Revoke token* ends the external trigger. Calls need no session and no CSRF header (`X-Trigger-Token: kt_…` works as well as `Authorization`), are limited to 60 per minute and IP, and every call is audited (`knowledge.sync` with trigger `external`, failures as `knowledge.trigger_failed`).

**Author and last change:** every document records who last changed it and when, as far as the source tells: Confluence (last editor and version time; on Cloud the editor name is resolved when a page is re-indexed), SharePoint/OneDrive (last modified by/at), file shares (file modification time, no author), uploads (the uploading admin, upload time) and approved articles (the writer). Documents indexed before this was recorded are filled in on the next sync where the source lists the values; others on their next change. The “Documents” list shows both columns; search results and the MCP tools return them on request (see [API](api.md)).

**What gets indexed:** PDF (with a text layer), DOCX, PPTX, XLSX, HTML, Markdown, text, CSV/JSON/YAML/XML and source code. Scanned PDFs without text, images and other binaries are skipped with a note. Only text is stored — hits link to the original in the source system; uploads link to a text version.

### Sync problems

A failed run shows ✕ and its error in the source's *Last run* column; “Documents” shows per-document errors. A source that fails keeps its previous content. The portal's own error texts appear in German, the cause is in the technical part.

| Message | Meaning and fix |
| --- | --- |
| `Kein Embedding-Modell konfiguriert` (no embedding model configured) | Set the embedding model first ([1. Embedding model](#1-embedding-model)) |
| `… HTTP 401` or `HTTP 403` | Credentials wrong, expired or without permission: Confluence token, SharePoint client secret, or the request header of a web source. Replace the credentials in the source's *Settings* panel (*Replace & sync* tests them at once) |
| Web source: `Weiterleitung nach … außerhalb des erlaubten Bereichs (Login-Seite?)` | The start URL redirects to another host or path, typically a login page. Give the source a request header (token, API key, session cookie) or correct the URL / path prefix |
| `Space … nicht gefunden oder kein Zugriff` | Wrong space key, or the account cannot see the space (Confluence Cloud) |
| `Quelle lieferte keine Dokumente – der bestehende Inhalt bleibt erhalten` | A *full replace* found nothing: empty or unmounted share, wrong path, a site that answers without links. The content is kept; fix the source |
| `Embedding fehlgeschlagen: …` on a document | The embedding model is unreachable or rejects the text; check the provider, the next run retries |
| Documents `skipped` | No extractable text (scanned PDF, image, unsupported format) |

### Reviewing contributed articles

Signed-in users can submit Markdown articles to collections they can access via **Contribute article**. Pending submissions appear under **Review articles** in the **Knowledge base** admin tab with their author, collection and full text. **Approve** indexes the text and makes it searchable according to the collection's access rules; **Reject** leaves it unpublished. If indexing fails, the article stays pending so an admin can retry. Approved articles are managed alongside uploaded documents.

## Audit log

**Tab “Audit log”**

Filter by user, action prefix (e.g. `auth.`, `chat.`, `knowledge.`) and time range. “CSV export” downloads the filtered entries (up to 100,000 rows); the export itself is audited. Failed actions are highlighted. See [security & audit](security.md#audit-events) for the list of events.

## Plugins

**Tab “Plugins”** lists code-deployed plugins, initially disabled. Check **Active** to enable a plugin's page, chat tools and API routes; uncheck it to disable them. The setting persists in the database across restarts and replicas. Only trusted code deployed with the server can provide a plugin; see [Plugins](plugins.md) for registration and the included Text statistics example.

## Notes on entries

Every admin table has a **Comment** column for small notes (up to 300 characters; 200 for SSO assignments): who is responsible, a ticket number, when a contract or token runs out, why a group was assigned. Click the text (or *+ note*), type, and press Enter or leave the field to save; Escape cancels; saving an empty text removes the note. Notes exist for users, AI providers, models, knowledge collections and sources, and SSO assignments (environment entries cannot carry one).

Notes are for admins only: the model picker, the knowledge collection list and the profile that ordinary users see never contain them, and they have no influence on access, roles or behaviour. Changes are audited with the entry's other changes. Do not put credentials into notes: only secret-looking patterns are masked in logs and audit entries.

## Routine tasks

| Task | How |
| --- | --- |
| Rotate a provider key | “Key” on the provider row |
| Offboard a user | Deactivate (keeps history) or delete (removes chats, files, MCP servers and tokens) |
| Investigate an incident | Audit log filtered by user and time range; stdout logs in your log stack |
| Pause a source | *Settings* → untick *Source active*; tick it again to resume. Its documents stay searchable |
| Check knowledge freshness | Status and last run per source; failed runs are audited as `knowledge.sync` with `success = false` |
| Replace a leaked or expired source credential | *Settings* on the source row → *Credentials* (write-only, replaces the whole set); for a webhook token use *Create new token* in the same panel |
| Rotate the LDAP bind password or the OIDC client secret | Change the secret in the deployment's environment or Kubernetes secret and restart the pods |
| Rotate `SESSION_SECRET` | Set the new value on all pods and restart: everyone has to sign in again |
| Rotate `ENCRYPTION_KEY` | **No rotation procedure exists.** Stored provider keys, MCP headers and source credentials are encrypted with it; with a new key they cannot be read any more, so every credential would have to be entered again. Keep the key safe instead ([installation](installation.md#secrets-you-must-generate)) |
| Remove a provider or model | Disable first; deleting keeps chats but removes the entry ([AI providers and models](#ai-providers-and-models)) |

### Recovering admin access

If no admin can sign in any more:

- **SSO admins:** if admin rules exist (`OIDC_ADMIN_GROUPS`, `OIDC_ADMIN_USERS`, or an admin assignment), such a person becomes admin again at their next SSO sign-in. Adding the variable to the deployment and restarting is enough.
- **Local admin password:** generate a bcrypt hash (cost 12) with the tools in the image and write it into the database as a database admin:

  ```bash
  docker compose exec app node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'a-temporary-password-123'
  # then, in PostgreSQL:
  UPDATE users SET password_hash = '<hash>', active = true, role = 'admin' WHERE username = 'admin' AND auth_source = 'local';
  ```

  Sign in with the temporary password and change it right away. `BOOTSTRAP_ADMIN_PASSWORD` is only used while the database has no user at all, so it cannot be used for this.
