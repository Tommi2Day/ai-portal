# Plugins

Plugins are trusted code shipped with the portal image. They can expose authenticated HTTP endpoints, AI SDK tools in chat, and a bundled React page. Administrators can enable or disable each deployed plugin under **Administration → Plugins**; this setting is stored in PostgreSQL's `settings` table and applies across replicas. New plugins start disabled until an admin enables them. Disabling a plugin hides its page and tools from new requests and returns 404 from its HTTP routes. A tool checks the setting again immediately before execution; calls already running cannot be cancelled by the toggle.

The built-in **Text statistics** plugin shows all three surfaces: the page counts words and characters through `POST /api/plugins/text-stats/count`, and chat models can call `plugin_text_stats__count_text`. It does not send text to a third party.

## Adding a plugin

1. Implement `PortalPlugin` from `server/src/plugins/types.ts` in `server/src/plugins/<name>.ts`. Give it a unique lowercase slug ID (up to 20 characters), a display name and description. Optional `router` routes are mounted at `/api/plugins/<id>` after session, CSRF and `requireAuth` middleware; use `req.user` for authorization, validate inputs, and check permissions inside the plugin. Optional `tools` are AI SDK dynamic tools; use lowercase identifier names (up to 30 characters). Their names become `plugin_<id>__<tool>` (with hyphens replaced by underscores), and each `execute(input, user)` must validate its input. Do not trust model-supplied arguments.
2. Register the module in `server/src/plugins/index.ts`. Only registered, bundled modules can run; there is no package upload, arbitrary filesystem loading, or sandboxing. Plugins run with the same process permissions as the server, so review their code and dependencies before deployment.
3. For a page, add a React component under `web/src/plugins/`, register the same ID in `web/src/plugins/index.ts`, and set `hasPage: true` on the server plugin. The portal fetches the enabled list from `GET /api/plugins`, shows a navigation item for each bundled page, and removes it when the plugin is disabled. Use `web/src/api.ts` for authenticated plugin requests.
4. Build and deploy both packages. If a plugin needs persistent data, add its tables to `server/src/db/schema.ts` and generate a Drizzle migration. Prefer namespaced table and setting keys to avoid collisions.

The list and toggle endpoints are `GET /api/admin/plugins` and `PATCH /api/admin/plugins/:id` with `{ "enabled": false }` (admin only). Users may call `GET /api/plugins` to list enabled plugin metadata. Tool calls and toggles write audit actions `plugin.tool_call` and `plugin.update`. Plugin routes should add their own audit events when they perform sensitive actions.

Plugin tool names must not collide with a user's MCP tool names; chat reports an error instead of silently replacing either tool if they do.
