import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { evaluateClaims } from '../auth/oidc.js';
import { loadAssignments } from '../auth/oidcAssignments.js';
import { toSessionUser, type SessionUser } from '../auth/session.js';

/**
 * OAuth 2.0 access tokens on /mcp (portal = resource server, the identity provider issues the tokens).
 * Validates signature (JWKS of the issuer), issuer, audience and lifetime locally, like oracle-mcp-server.
 * Deny by default: the token's subject must belong to a portal user that already signed in via OIDC.
 */

const list = (v?: string) => (v ?? '').split(/[\s,]+/).filter(Boolean);

export const oauthEnabled = () => !!config.MCP_OAUTH_ISSUER;
const issuers = () => (config.MCP_OAUTH_ALLOWED_ISSUERS ? list(config.MCP_OAUTH_ALLOWED_ISSUERS) : [config.MCP_OAUTH_ISSUER!]);
const audiences = () => list(config.MCP_OAUTH_AUDIENCE ?? config.OIDC_CLIENT_ID);
const resourceUrl = () => `${config.PUBLIC_URL.replace(/\/$/, '')}/mcp`;
export const metadataUrl = () => `${config.PUBLIC_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource`;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getJwks() {
  if (jwks) return jwks;
  let uri = config.MCP_OAUTH_JWKS_URI;
  if (!uri) {
    const res = await fetch(`${config.MCP_OAUTH_ISSUER!.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    uri = ((await res.json()) as { jwks_uri?: string }).jwks_uri;
    if (!uri) throw new Error('OIDC discovery document has no jwks_uri');
  }
  return (jwks = createRemoteJWKSet(new URL(uri)));
}

/** Test hook: forget the cached key set. */
export const resetOauthCache = () => { jwks = null; };

/** Asymmetric algorithms only: never HS* (key confusion) or "none". */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const aud = audiences();
  if (!aud.length) throw new Error('MCP_OAUTH_AUDIENCE (or OIDC_CLIENT_ID) must be set');
  const { payload } = await jwtVerify(token, await getJwks(), { issuer: issuers(), audience: aud, algorithms: ALGORITHMS, clockTolerance: 30 });
  return payload;
}

/** Misconfigurations worth a log line at startup (weakens the checks, does not stop the server). */
export function oauthWarnings(): string[] {
  if (!oauthEnabled()) return [];
  const w: string[] = [];
  if (!/^https:\/\//i.test(config.MCP_OAUTH_ISSUER!)) w.push('MCP_OAUTH_ISSUER is not https: tokens and keys are fetched without transport security');
  if (!config.MCP_OAUTH_AUDIENCE) w.push('MCP_OAUTH_AUDIENCE is not set: falling back to OIDC_CLIENT_ID, which is also the audience of ID tokens of the portal login - set a dedicated audience (e.g. api://<app-id>)');
  if (issuers().length > 1) w.push('MCP_OAUTH_ALLOWED_ISSUERS lists several issuers: users are matched by subject only, so every listed issuer must be under your control (a subject is unique per issuer, not across issuers)');
  if (!audiences().length) w.push('no audience configured: every token will be rejected');
  return w;
}

/** Portal user for a verified access token; throws a reason string-bearing Error when not allowed. */
export async function userForClaims(c: JWTPayload): Promise<SessionUser> {
  const externalId = String((c as Record<string, unknown>).oid ?? c.sub ?? '');
  if (!externalId) throw new Error('token has no subject');
  const a = evaluateClaims(c as Record<string, unknown>, await loadAssignments());
  if (!a.allowed) throw new Error('not authorized (OIDC_USER_VALUE / OIDC_ALLOWED_*)');
  const [u] = await db.select().from(users).where(and(eq(users.authSource, 'oidc'), eq(users.externalId, externalId)));
  if (!u) throw new Error('unknown user (must sign in to the portal once)');
  if (!u.active) throw new Error('user deactivated');
  const user = toSessionUser(u);
  // the token is authoritative (as at sign-in): groups the identity provider no longer lists are not kept from the last sign-in
  return { ...user, groups: [...new Set(a.groups)] };
}

/** RFC 9728 protected resource metadata: lets MCP clients discover the issuer and run the login themselves. */
export function protectedResourceMetadata(_req: Request, res: Response) {
  if (!oauthEnabled()) return res.status(404).end();
  const aud = audiences();
  const scopes = config.MCP_OAUTH_RESOURCE_SCOPES ? list(config.MCP_OAUTH_RESOURCE_SCOPES) : aud.length ? [`${aud[0]}/.default`] : [];
  res.json({
    resource: resourceUrl(),
    authorization_servers: [config.MCP_OAUTH_ISSUER],
    bearer_methods_supported: ['header'],
    ...(scopes.length ? { scopes_supported: scopes } : {}),
  });
}
