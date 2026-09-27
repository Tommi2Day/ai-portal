import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { assertAllowedUrl } from '../src/ai/mcp.js';
import { resolveFsPath } from '../src/knowledge/connectors/filesystem.js';
import { cnOf, escapeFilter } from '../src/auth/ldap.js';
import { csrfGuard, requireAdmin, requireAuth, type SessionUser } from '../src/auth/session.js';

describe('assertAllowedUrl (SSRF guard for user MCP servers)', () => {
  const allowPrivate = config.MCP_ALLOW_PRIVATE_NETWORKS;
  afterEach(() => { config.MCP_ALLOW_PRIVATE_NETWORKS = allowPrivate; });

  it('accepts only http and https', async () => {
    await expect(assertAllowedUrl('https://mcp.example.com/mcp')).resolves.toBeUndefined();
    await expect(assertAllowedUrl('http://mcp.example.com/mcp')).resolves.toBeUndefined();
    for (const u of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host', 'javascript:alert(1)']) {
      await expect(assertAllowedUrl(u)).rejects.toThrow('Nur http(s)-URLs sind erlaubt');
    }
  });

  it('allows private addresses by default (MCP_ALLOW_PRIVATE_NETWORKS=true)', async () => {
    config.MCP_ALLOW_PRIVATE_NETWORKS = true;
    await expect(assertAllowedUrl('http://10.1.2.3:8080/mcp')).resolves.toBeUndefined();
  });

  it('blocks private, loopback, link-local and CGNAT addresses when disabled', async () => {
    config.MCP_ALLOW_PRIVATE_NETWORKS = false;
    for (const ip of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1']) {
      await expect(assertAllowedUrl(`http://${ip}/mcp`), ip).rejects.toThrow('Private Netzadressen');
    }
    await expect(assertAllowedUrl('http://localhost:3000/mcp')).rejects.toThrow('Private Netzadressen');
  });

  it('lets public addresses through when private ones are disabled', async () => {
    config.MCP_ALLOW_PRIVATE_NETWORKS = false;
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1']) {
      await expect(assertAllowedUrl(`https://${ip}/mcp`), ip).resolves.toBeUndefined();
    }
  });

  it('rejects invalid URLs', async () => {
    await expect(assertAllowedUrl('not a url')).rejects.toThrow();
  });
});

describe('resolveFsPath (file-share sources stay inside KNOWLEDGE_FS_ROOT)', () => {
  const root = path.resolve(config.KNOWLEDGE_FS_ROOT);

  it('resolves paths relative to the root, also with a leading slash', () => {
    expect(resolveFsPath('it-ops')).toBe(path.join(root, 'it-ops'));
    expect(resolveFsPath('/it-ops/runbooks')).toBe(path.join(root, 'it-ops', 'runbooks'));
    expect(resolveFsPath('.')).toBe(root);
  });

  it('rejects paths that escape the root', () => {
    for (const p of ['..', '../etc', 'it-ops/../../etc', `../${path.basename(root)}-other`]) {
      expect(() => resolveFsPath(p), p).toThrow(/Pfad liegt außerhalb von/);
    }
  });
});

describe('LDAP helpers', () => {
  it('escapes filter values per RFC 4515', () => {
    expect(escapeFilter('j.meyer')).toBe('j.meyer');
    expect(escapeFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    expect(escapeFilter('a\\b')).toBe('a\\5cb');
    expect(escapeFilter('nul\0')).toBe('nul\\00');
  });

  it('extracts the CN of a group DN', () => {
    expect(cnOf('CN=AI-Portal-Users,OU=Groups,DC=example,DC=local')).toBe('AI-Portal-Users');
    expect(cnOf('cn=Team\\, Ops,ou=groups,dc=x')).toBe('Team, Ops');
    expect(cnOf('ou=NoCn,dc=x')).toBe('ou=NoCn,dc=x');
  });
});

describe('session guards', () => {
  const user = (role: 'admin' | 'user') => ({ id: 'u1', username: 'x', role }) as SessionUser;
  const req = (p: { method?: string; path?: string; headers?: Record<string, string>; user?: SessionUser }) =>
    ({ method: p.method ?? 'GET', path: p.path ?? '/api/chats', user: p.user, get: (h: string) => p.headers?.[h.toLowerCase()] }) as unknown as Request;
  const res = () => {
    const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
    return r;
  };
  const run = (guard: (req: Request, res: Response, next: NextFunction) => unknown, rq: Request) => {
    const rs = res();
    const next = vi.fn();
    guard(rq, rs as unknown as Response, next);
    return { status: rs.statusCode, body: rs.body, next: next.mock.calls.length > 0 };
  };

  it('csrfGuard lets reads through and requires the header for writes', () => {
    expect(run(csrfGuard, req({ method: 'GET' })).next).toBe(true);
    expect(run(csrfGuard, req({ method: 'HEAD' })).next).toBe(true);
    expect(run(csrfGuard, req({ method: 'POST' }))).toEqual({ status: 403, body: { error: 'csrf' }, next: false });
    expect(run(csrfGuard, req({ method: 'DELETE', headers: { 'x-requested-with': 'XMLHttpRequest' } })).status).toBe(403);
    expect(run(csrfGuard, req({ method: 'POST', headers: { 'x-requested-with': 'ai-portal' } })).next).toBe(true);
  });

  it('csrfGuard exempts the OIDC callback', () => {
    expect(run(csrfGuard, req({ method: 'POST', path: '/api/auth/oidc/callback' })).next).toBe(true);
  });

  it('requireAuth needs a user', () => {
    expect(run(requireAuth, req({}))).toEqual({ status: 401, body: { error: 'unauthenticated' }, next: false });
    expect(run(requireAuth, req({ user: user('user') })).next).toBe(true);
  });

  it('requireAdmin needs the admin role', () => {
    expect(run(requireAdmin, req({})).status).toBe(401);
    expect(run(requireAdmin, req({ user: user('user') }))).toEqual({ status: 403, body: { error: 'forbidden' }, next: false });
    expect(run(requireAdmin, req({ user: user('admin') })).next).toBe(true);
  });
});
