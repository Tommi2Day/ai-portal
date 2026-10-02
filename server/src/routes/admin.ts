import { Router } from 'express';
import { and, asc, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { auditLog, models, providers, users } from '../db/schema.js';
import { audit } from '../audit.js';
import { encryptJson } from '../crypto.js';
import { hashPassword } from '../auth/local.js';
import { MODEL_PRESETS } from '../ai/providers.js';
import { bedrockAuth, listAvailableModels } from '../ai/bedrock.js';

export const adminRouter = Router();

const bad = (res: import('express').Response, e: z.ZodError) => res.status(400).json({ error: 'Ungültige Eingabe', issues: e.issues });

/* ---------------- Users ---------------- */

const publicUser = {
  id: users.id, username: users.username, displayName: users.displayName, email: users.email,
  authSource: users.authSource, role: users.role, groups: users.groups, active: users.active, pendingApproval: users.pendingApproval, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
};

adminRouter.get('/users', async (_req, res) => {
  res.json(await db.select(publicUser).from(users).orderBy(asc(users.username)));
});

const newUser = z.object({
  username: z.string().min(2).max(100).regex(/^[a-zA-Z0-9._@-]+$/),
  password: z.string().min(12).max(200),
  displayName: z.string().max(200).optional(),
  email: z.string().email().optional().or(z.literal('')),
  role: z.enum(['admin', 'user']).default('user'),
});

adminRouter.post('/users', async (req, res) => {
  const p = newUser.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const d = p.data;
  const [u] = await db.insert(users).values({
    username: d.username.toLowerCase(), displayName: d.displayName || null, email: d.email || null,
    role: d.role, authSource: 'local', passwordHash: await hashPassword(d.password),
  }).onConflictDoNothing().returning(publicUser);
  if (!u) return res.status(409).json({ error: 'Benutzername existiert bereits' });
  await audit(req, { action: 'user.create', targetType: 'user', targetId: u.id, details: { username: u.username, role: u.role } });
  res.status(201).json(u);
});

const patchUser = z.object({
  role: z.enum(['admin', 'user']).optional(),
  active: z.boolean().optional(),
  displayName: z.string().max(200).optional(),
  password: z.string().min(12).max(200).optional(),
  /** Only meaningful for local users – LDAP/OIDC groups are overwritten at each login. */
  groups: z.array(z.string().min(1).max(200)).max(200).optional(),
});

adminRouter.patch('/users/:id', async (req, res) => {
  const p = patchUser.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (req.params.id === req.user!.id && (p.data.role === 'user' || p.data.active === false)) {
    return res.status(400).json({ error: 'Eigene Admin-Rechte können nicht entzogen werden' });
  }
  const [target] = await db.select().from(users).where(eq(users.id, req.params.id));
  if (!target) return res.status(404).end();
  if (p.data.password && target.authSource !== 'local') return res.status(400).json({ error: 'Passwort nur für lokale Benutzer' });
  const { password, ...rest } = p.data;
  const [u] = await db.update(users)
    .set({ ...rest, ...(rest.active ? { pendingApproval: false } : {}), ...(password ? { passwordHash: await hashPassword(password) } : {}) })
    .where(eq(users.id, target.id)).returning(publicUser);
  await audit(req, { action: 'user.update', targetType: 'user', targetId: u.id, details: { ...rest, passwordChanged: !!password } });
  res.json(u);
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Eigenes Konto kann nicht gelöscht werden' });
  const [u] = await db.delete(users).where(eq(users.id, req.params.id)).returning({ id: users.id, username: users.username });
  if (!u) return res.status(404).end();
  await audit(req, { action: 'user.delete', targetType: 'user', targetId: u.id, details: { username: u.username } });
  res.status(204).end();
});

/* ---------------- Providers ---------------- */

const providerPublic = {
  id: providers.id, name: providers.name, type: providers.type, baseUrl: providers.baseUrl, region: providers.region,
  options: providers.options, enabled: providers.enabled, createdAt: providers.createdAt,
  hasSecret: sql<boolean>`${providers.secretEnc} is not null`,
};

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

const providerBody = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['anthropic', 'bedrock', 'github', 'openai_compatible']),
  baseUrl: z.string().url().optional().or(z.literal('')),
  region: z.string().max(50).optional(),
  /** GitHub: org. Bedrock: auth (keys | apiKey | iam), roleArn and externalId for AssumeRole. */
  options: z.record(z.string(), z.string()).refine(
    (o) => (!o.auth || ['keys', 'apiKey', 'iam'].includes(o.auth)) && (!o.roleArn || ROLE_ARN.test(o.roleArn)),
    'Ungültige Bedrock-Optionen (auth: keys, apiKey oder iam; roleArn: arn:aws:iam::<Konto>:role/<Name>)',
  ).optional(),
  enabled: z.boolean().optional(),
  /** Write-only. Omit to keep the stored secret. */
  secret: z.object({
    apiKey: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
  }).optional(),
});

adminRouter.get('/providers', async (_req, res) => {
  res.json(await db.select(providerPublic).from(providers).orderBy(asc(providers.name)));
});

adminRouter.get('/model-presets', (_req, res) => res.json(MODEL_PRESETS));

/**
 * Models the provider offers. Bedrock: queried from the AWS account (inference profiles, foundation models,
 * model access); other types and Bedrock with a static API key: the presets. `?refresh=1` bypasses the cache.
 */
adminRouter.get('/providers/:id/available-models', async (req, res) => {
  const [p] = await db.select().from(providers).where(eq(providers.id, req.params.id));
  if (!p) return res.status(404).json({ error: 'Anbieter unbekannt' });
  const presets = MODEL_PRESETS[p.type].map((m) => ({ ...m, kind: 'chat', via: 'preset', access: 'unknown', legacy: false }));
  if (p.type !== 'bedrock' || bedrockAuth(p) === 'apiKey') return res.json({ source: 'presets', models: presets });
  try {
    res.json({ source: 'account', models: await listAvailableModels(p, { refresh: req.query.refresh === '1' }) });
  } catch (e) {
    // e.g. missing bedrock:List* permission or no credentials: show the presets with the reason
    res.json({ source: 'presets', models: presets, error: (e as Error).message });
  }
});

adminRouter.post('/providers', async (req, res) => {
  const p = providerBody.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const { secret, ...d } = p.data;
  const [row] = await db.insert(providers).values({
    ...d, baseUrl: d.baseUrl || null, options: d.options ?? {}, secretEnc: secret ? encryptJson(secret) : null,
  }).returning({ id: providers.id });
  await audit(req, { action: 'provider.create', targetType: 'provider', targetId: row.id, details: { name: d.name, type: d.type } });
  res.status(201).json(row);
});

adminRouter.patch('/providers/:id', async (req, res) => {
  const p = providerBody.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const { secret, ...d } = p.data;
  const [row] = await db.update(providers).set({
    ...d, ...(d.baseUrl !== undefined ? { baseUrl: d.baseUrl || null } : {}), ...(secret ? { secretEnc: encryptJson(secret) } : {}),
  }).where(eq(providers.id, req.params.id)).returning({ id: providers.id });
  if (!row) return res.status(404).end();
  await audit(req, { action: 'provider.update', targetType: 'provider', targetId: row.id, details: { ...d, secretChanged: !!secret } });
  res.json(row);
});

adminRouter.delete('/providers/:id', async (req, res) => {
  const [row] = await db.delete(providers).where(eq(providers.id, req.params.id)).returning({ id: providers.id, name: providers.name });
  if (!row) return res.status(404).end();
  await audit(req, { action: 'provider.delete', targetType: 'provider', targetId: row.id, details: { name: row.name } });
  res.status(204).end();
});

/* ---------------- Models (the predefined selection users can pick from) ---------------- */

const modelBody = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  supportsImages: z.boolean().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sort: z.number().int().optional(),
});

adminRouter.get('/models', async (_req, res) => {
  res.json(await db.select().from(models).orderBy(asc(models.sort), asc(models.displayName)));
});

async function clearDefaultIf(isDefault?: boolean) {
  if (isDefault) await db.update(models).set({ isDefault: false });
}

adminRouter.post('/models', async (req, res) => {
  const p = modelBody.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  await clearDefaultIf(p.data.isDefault);
  const [row] = await db.insert(models).values(p.data).returning();
  await audit(req, { action: 'model.create', targetType: 'model', targetId: row.id, details: { modelId: row.modelId } });
  res.status(201).json(row);
});

adminRouter.patch('/models/:id', async (req, res) => {
  const p = modelBody.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  await clearDefaultIf(p.data.isDefault);
  const [row] = await db.update(models).set(p.data).where(eq(models.id, req.params.id)).returning();
  if (!row) return res.status(404).end();
  await audit(req, { action: 'model.update', targetType: 'model', targetId: row.id, details: p.data });
  res.json(row);
});

adminRouter.delete('/models/:id', async (req, res) => {
  const [row] = await db.delete(models).where(eq(models.id, req.params.id)).returning();
  if (!row) return res.status(404).end();
  await audit(req, { action: 'model.delete', targetType: 'model', targetId: row.id, details: { modelId: row.modelId } });
  res.status(204).end();
});

/* ---------------- Audit log ---------------- */

const auditQuery = z.object({
  user: z.string().optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(200),
  offset: z.coerce.number().min(0).default(0),
  format: z.enum(['json', 'csv']).default('json'),
});

adminRouter.get('/audit', async (req, res) => {
  const q = auditQuery.parse(req.query);
  const where: SQL[] = [];
  if (q.user) where.push(ilike(auditLog.username, `%${q.user}%`));
  if (q.action) where.push(ilike(auditLog.action, `${q.action}%`));
  if (q.from) where.push(gte(auditLog.ts, new Date(q.from)));
  if (q.to) where.push(lte(auditLog.ts, new Date(q.to)));
  const rows = await db.select().from(auditLog).where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.ts)).limit(q.format === 'csv' ? 100_000 : q.limit).offset(q.offset);

  if (q.format === 'csv') {
    await audit(req, { action: 'audit.export', details: { filter: { ...q, format: undefined }, rows: rows.length } });
    const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const header = 'ts,username,action,target_type,target_id,success,ip,details';
    const lines = rows.map((r) => [r.ts.toISOString(), r.username, r.action, r.targetType, r.targetId, r.success, r.ip, JSON.stringify(r.details ?? {})].map(esc).join(','));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send([header, ...lines].join('\n'));
  }
  res.json(rows);
});
