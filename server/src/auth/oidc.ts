import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Issuer, generators, type Client } from 'openid-client';
import { config } from '../config.js';
import type { User } from '../db/schema.js';
import { loadAssignments, type Assignment } from './oidcAssignments.js';
import { LoginError, upsertExternalUser } from './provision.js';

const FLOW_COOKIE = 'ap_oidc';
const redirectUri = () => `${config.PUBLIC_URL}/api/auth/oidc/callback`;

const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const values = (c: Record<string, unknown>, name: string) => ([] as unknown[]).concat(c[name] ?? []).map(String);
const userMatches = (patterns: string[], ids: string[]) =>
  patterns.some((p) => (p.startsWith('*@') ? ids.some((i) => i.endsWith(p.slice(1))) : ids.includes(p)));

/**
 * Authorization decision for verified OIDC claims (ID token at sign-in, access token on /mcp):
 * allowed (deny by default once OIDC_ALLOWED_* is set), admin (OIDC_ADMIN_*), groups and the usable e-mail.
 * Groups, e-mails (`*@domain`) and object ids are compared case-insensitively.
 */
export function evaluateClaims(c: Record<string, unknown>, assigned: Assignment[] = []) {
  const roles = values(c, config.OIDC_ROLE_CLAIM);
  const groups = [...roles, ...values(c, config.OIDC_GROUP_CLAIM)];
  const verified = c.email_verified === undefined ? null : c.email_verified === true || c.email_verified === 'true';
  const trustEmail = verified === null ? !config.OIDC_REQUIRE_VERIFIED_EMAIL : verified;
  const email = trustEmail ? String(c.email ?? c.preferred_username ?? c.upn ?? '') || null : null;
  const ids = [...new Set([email, c.preferred_username, c.upn, c.oid, c.sub].filter(Boolean).map((x) => String(x).toLowerCase()))]
    .filter((id) => trustEmail || id === String(c.oid ?? '').toLowerCase() || id === String(c.sub ?? '').toLowerCase());
  const lowerGroups = groups.map((g) => g.toLowerCase());
  const inGroup = (names: string[]) => names.some((n) => lowerGroups.includes(n));

  const mine = (admin: boolean | null) => {
    const sel = assigned.filter((a) => admin === null || a.admin === admin);
    const names = (t: Assignment['type']) => sel.filter((a) => a.type === t).map((a) => a.value.trim().toLowerCase());
    return { groups: names('group'), users: names('user'), any: sel.length > 0 };
  };
  const adm = mine(true), all = mine(null), allow = mine(false);
  const adminConfigured = !!config.OIDC_ADMIN_VALUE || !!config.OIDC_ADMIN_GROUPS || !!config.OIDC_ADMIN_USERS || adm.any;
  const admin = (!!config.OIDC_ADMIN_VALUE && roles.includes(config.OIDC_ADMIN_VALUE))
    || inGroup([...list(config.OIDC_ADMIN_GROUPS), ...adm.groups]) || userMatches([...list(config.OIDC_ADMIN_USERS), ...adm.users], ids);

  const restricted = !!config.OIDC_USER_VALUE || !!config.OIDC_ALLOWED_GROUPS || !!config.OIDC_ALLOWED_USERS || allow.any;
  const matched = (!!config.OIDC_USER_VALUE && roles.includes(config.OIDC_USER_VALUE))
    || inGroup([...list(config.OIDC_ALLOWED_GROUPS), ...all.groups]) || userMatches([...list(config.OIDC_ALLOWED_USERS), ...all.users], ids);
  return {
    allowed: admin || !restricted || matched,
    admin, groups, email,
    roleFromIdp: adminConfigured ? (admin ? 'admin' : 'user') as 'admin' | 'user' : null,
  };
}

let clientPromise: Promise<Client> | null = null;
function getClient() {
  clientPromise ??= Issuer.discover(config.OIDC_ISSUER!).then(
    (issuer) =>
      new issuer.Client({
        client_id: config.OIDC_CLIENT_ID!,
        client_secret: config.OIDC_CLIENT_SECRET,
        redirect_uris: [redirectUri()],
        response_types: ['code'],
      }),
  ).catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

/** Stateless: PKCE verifier, state and nonce travel in a short-lived signed cookie. */
export async function oidcStart(_req: Request, res: Response) {
  const client = await getClient();
  const code_verifier = generators.codeVerifier();
  const state = generators.state();
  const nonce = generators.nonce();
  const flow = jwt.sign({ code_verifier, state, nonce }, config.SESSION_SECRET, { expiresIn: '10m' });
  res.cookie(FLOW_COOKIE, flow, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 600_000, path: '/api/auth/oidc' });
  res.redirect(client.authorizationUrl({
    scope: config.OIDC_SCOPES,
    code_challenge: generators.codeChallenge(code_verifier),
    code_challenge_method: 'S256',
    state, nonce,
  }));
}

export async function oidcCallback(req: Request, res: Response): Promise<User> {
  const client = await getClient();
  const raw = req.cookies?.[FLOW_COOKIE];
  res.clearCookie(FLOW_COOKIE, { path: '/api/auth/oidc' });
  if (!raw) throw new LoginError('Anmeldevorgang abgelaufen');
  const flow = jwt.verify(raw, config.SESSION_SECRET) as { code_verifier: string; state: string; nonce: string };
  const tokenSet = await client.callback(redirectUri(), client.callbackParams(req), flow);
  const c = tokenSet.claims() as Record<string, unknown>;

  const a = evaluateClaims(c, await loadAssignments());
  if (!a.allowed) throw new LoginError('Keine Berechtigung für das AI Portal');
  return upsertExternalUser({
    groups: a.groups,
    source: 'oidc',
    externalId: String(c.oid ?? c.sub), // Azure: stable object id
    username: String(c.preferred_username ?? c.upn ?? c.email ?? c.sub),
    displayName: (c.name as string) ?? null,
    email: a.email,
    roleFromIdp: a.roleFromIdp,
  });
}
