import { eq } from 'drizzle-orm';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { audit } from '../audit.js';
import type { SessionUser } from '../auth/session.js';
import { samplePlugin } from './sample.js';
import type { PortalPlugin } from './types.js';

// Register code-deployed plugins here; each module is bundled into dist/plugins/.
export const plugins: readonly PortalPlugin[] = [samplePlugin];
const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
if (byId.size !== plugins.length || plugins.some((p) => !/^[a-z][a-z0-9-]{0,19}$/.test(p.id)
  || Object.keys(p.tools ?? {}).some((name) => !/^[a-z][a-z0-9_]{0,29}$/.test(name)))) {
  throw new Error('Plugin IDs must be unique slugs (max 20) and tool names lowercase identifiers (max 30)');
}

export const getPlugin = (id: string) => byId.get(id);
const key = (id: string) => `plugin.${id}.enabled`;

/** New deployments are opt-in: unconfigured plugins remain disabled. */
export async function pluginEnabled(id: string): Promise<boolean> {
  if (!byId.has(id)) return false;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key(id)));
  return row?.value === true;
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  await db.insert(settings).values({ key: key(id), value: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: enabled, updatedAt: new Date() } });
}

export async function listPlugins(includeDisabled = false) {
  const entries = await Promise.all(plugins.map(async (p) => ({
    id: p.id, name: p.name, description: p.description, hasPage: !!p.hasPage, enabled: await pluginEnabled(p.id),
  })));
  return includeDisabled ? entries : entries.filter((p) => p.enabled);
}

/** Namespace tools to avoid collisions with core and user MCP tools. Check state again at execution. */
export async function pluginTools(user: SessionUser): Promise<ToolSet> {
  const tools: ToolSet = {};
  for (const plugin of plugins) {
    if (!await pluginEnabled(plugin.id)) continue;
    for (const [name, definition] of Object.entries(plugin.tools ?? {})) {
      tools[`plugin_${plugin.id.replaceAll('-', '_')}__${name}`] = dynamicTool({
        description: `[${plugin.name}] ${definition.description}`,
        inputSchema: jsonSchema(definition.inputSchema),
        execute: async (input) => {
          const start = Date.now();
          try {
            if (!await pluginEnabled(plugin.id)) throw new Error('Plugin deaktiviert');
            const result = await definition.execute(input, user);
            await audit(null, { action: 'plugin.tool_call', userId: user.id, username: user.username,
              targetType: 'plugin', targetId: plugin.id, details: { tool: name, ms: Date.now() - start } });
            return result;
          } catch (error) {
            await audit(null, { action: 'plugin.tool_call', userId: user.id, username: user.username,
              targetType: 'plugin', targetId: plugin.id, success: false,
              details: { tool: name, ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) } });
            throw error;
          }
        },
      });
    }
  }
  return tools;
}
