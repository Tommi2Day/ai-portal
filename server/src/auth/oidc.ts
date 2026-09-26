import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Issuer, generators, type Client } from 'openid-client';
import { config } from '../config.js';
import type { User } from '../db/schema.js';
import { LoginError, upsertExternalUser } from './provision.js';

const FLOW_COOKIE = 'ap_oidc';
const redirectUri = () => `${config.PUBLIC_URL}/api/auth/oidc/callback`;

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

  const claimVals = ([] as unknown[]).concat(c[config.OIDC_ROLE_CLAIM] ?? []).map(String);
  if (config.OIDC_USER_VALUE && !claimVals.includes(config.OIDC_USER_VALUE) && !(config.OIDC_ADMIN_VALUE && claimVals.includes(config.OIDC_ADMIN_VALUE))) {
    throw new LoginError('Keine Berechtigung für das AI Portal');
  }
  const roleFromIdp = config.OIDC_ADMIN_VALUE ? (claimVals.includes(config.OIDC_ADMIN_VALUE) ? 'admin' : 'user') : null;
  const username = String(c.preferred_username ?? c.upn ?? c.email ?? c.sub);
  const groups = [...claimVals, ...([] as unknown[]).concat(c[config.OIDC_GROUP_CLAIM] ?? []).map(String)];
  return upsertExternalUser({
    groups,
    source: 'oidc',
    externalId: String(c.oid ?? c.sub), // Azure: stable object id
    username,
    displayName: (c.name as string) ?? null,
    email: (c.email as string) ?? (c.preferred_username as string) ?? null,
    roleFromIdp,
  });
}
