import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { getPlugin, listPlugins, pluginEnabled, setPluginEnabled, plugins } from '../plugins/index.js';

export const pluginsRouter = Router();
export const pluginsAdminRouter = Router();

pluginsRouter.get('/', async (_req, res) => res.json(await listPlugins()));

for (const plugin of plugins) {
  if (!plugin.router) continue;
  pluginsRouter.use(`/${plugin.id}`, async (_req, res, next) => {
    if (!await pluginEnabled(plugin.id)) return res.status(404).json({ error: 'Plugin nicht verfügbar' });
    next();
  }, plugin.router);
}

pluginsAdminRouter.get('/', async (_req, res) => res.json(await listPlugins(true)));
pluginsAdminRouter.patch('/:id', async (req, res) => {
  const plugin = getPlugin(req.params.id);
  if (!plugin) return res.status(404).json({ error: 'Plugin nicht gefunden' });
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: parsed.error.issues });
  await setPluginEnabled(plugin.id, parsed.data.enabled);
  await audit(req, { action: 'plugin.update', targetType: 'plugin', targetId: plugin.id,
    details: { enabled: parsed.data.enabled } });
  res.json({ id: plugin.id, enabled: parsed.data.enabled });
});
