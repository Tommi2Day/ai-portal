import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
const { McpSettings } = await import('../src/McpSettings');
const { setLang } = await import('../src/i18n');

const srv = { id: 's1', name: 'Jira', url: 'https://mcp.acme.example/jira', transport: 'streamable-http', enabled: true, headerNames: ['Authorization'], lastStatus: 'ok', lastError: null, toolCount: 12 };
const tok = { id: 't1', name: 'LibreChat', prefix: 'ap_abc', expiresAt: '2026-12-27T00:00:00Z', lastUsedAt: null, createdAt: '2026-09-28T00:00:00Z' };

/** Routes api() calls by method and path; records them. */
function backend(state: { servers: object[]; tokens: object[] }) {
  api.mockImplementation(async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? (init.body ? 'POST' : 'GET');
    if (method === 'GET' && path === '/mcp-servers') return state.servers;
    if (method === 'GET' && path === '/tokens') return state.tokens;
    if (path === '/mcp-servers/s1/test') return { ok: true, tools: [{ name: 'search' }, { name: 'create_issue' }] };
    if (method === 'POST' && path === '/tokens') return { token: 'ap_new_secret' };
    return {};
  });
}

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('de'); api.mockReset(); dom = mount(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { dom.unmount(); vi.unstubAllGlobals(); });

describe('McpSettings', () => {
  it('lists servers with status and header names, tests and deletes a server', async () => {
    backend({ servers: [srv, { ...srv, id: 's2', name: 'Wiki', headerNames: [], lastStatus: 'error', lastError: 'timeout' }], tokens: [] });
    await dom.render(<McpSettings />);
    const rows = dom.$$('tbody')[0].querySelectorAll('tr');
    expect(rows[0].textContent).toContain('Header: Authorization');
    expect(rows[0].textContent).toContain('✓ 12 Tools');
    expect(rows[1].textContent).toContain('✕ timeout');

    await click(rows[0].querySelector<HTMLButtonElement>('button')!);
    expect(api).toHaveBeenCalledWith('/mcp-servers/s1/test', { method: 'POST' });
    expect(dom.$$('tbody')[0].textContent).toContain('search, create_issue');

    await click(rows[1].querySelector<HTMLButtonElement>('button.ghost')!);
    expect(api).toHaveBeenCalledWith('/mcp-servers/s2', { method: 'DELETE' });
  });

  it('adds a server with an authorization header', async () => {
    backend({ servers: [], tokens: [] });
    await dom.render(<McpSettings />);
    expect(dom.$$('tbody')[0].textContent).toContain('Noch keine MCP-Server.');
    const form = dom.$$<HTMLFormElement>('form')[0];
    // inputs: name, URL, header name (default "Authorization"), header value
    const [name, url, , headerValue] = form.querySelectorAll<HTMLInputElement>('input');
    await type(name, 'GitLab');
    await type(url, 'https://mcp.acme.example/gitlab');
    await type(form.querySelector('select')!, 'sse');
    await type(headerValue, 'Bearer glpat-1');
    await submit(form);
    expect(api).toHaveBeenCalledWith('/mcp-servers', {
      body: { name: 'GitLab', url: 'https://mcp.acme.example/gitlab', transport: 'sse', headers: { Authorization: 'Bearer glpat-1' } },
    });
  });

  it('creates an access token, shows it once in the setup snippets and revokes tokens', async () => {
    backend({ servers: [], tokens: [tok] });
    await dom.render(<McpSettings />);
    const tokenRow = dom.$$('tbody')[1].querySelector('tr')!;
    expect(tokenRow.textContent).toContain('ap_abc…');
    expect(tokenRow.textContent).toContain('nie');

    const form = dom.$$<HTMLFormElement>('form')[1];
    await type(form.querySelector('input')!, 'Claude Desktop');
    await type(form.querySelector('select')!, '30');
    await submit(form);
    expect(api).toHaveBeenCalledWith('/tokens', { body: { name: 'Claude Desktop', expiresInDays: 30 } });
    // the new token is masked until revealed, also in the setup snippet
    expect(dom.$('.card-box').textContent).not.toContain('ap_new_secret');
    expect(dom.$('.card-box').textContent).toContain('••••');
    expect(dom.$$('pre.snippet')[1].textContent).not.toContain('ap_new_secret');
    await click(dom.$$<HTMLButtonElement>('.card-box button').find((b) => b.textContent === 'Anzeigen')!);
    expect(dom.$('.card-box').textContent).toContain('ap_new_secret');
    expect(dom.$$('pre.snippet')[1].textContent).toContain('"TOKEN": "ap_new_secret"');

    await click(tokenRow.querySelector<HTMLButtonElement>('button')!);
    expect(api).toHaveBeenCalledWith('/tokens/t1', { method: 'DELETE' });
  });
});

describe('McpSettings: OAuth client credentials', () => {
  const label = (form: HTMLFormElement, text: string) => [...form.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(text))!.querySelector('input, select')! as HTMLInputElement;

  it('shows OAuth servers with their client id and creates one without sending a header', async () => {
    backend({ servers: [{ ...srv, id: 's3', name: 'PG', headerNames: [], oauth: { tokenUrl: 'https://idp.acme.example/token', clientId: 'portal-pg', scope: 'openid' } }], tokens: [] });
    await dom.render(<McpSettings />);
    expect(dom.$$('tbody')[0].textContent).toContain('OAuth 2.0: portal-pg');
    expect(dom.$$('tbody')[0].textContent).not.toContain('Header:');

    const form = dom.$$<HTMLFormElement>('form')[0];
    expect(form.textContent).not.toContain('Token-URL'); // header login is the default
    await type(label(form, 'Anmeldung'), 'oauth');
    expect(form.textContent).not.toContain('Header-Wert');
    await type(label(form, 'Name'), 'Oracle');
    await type(label(form, 'URL'), 'https://oracle-mcp.acme.example/mcp');
    await type(label(form, 'Token-URL'), 'https://idp.acme.example/token');
    await type(label(form, 'Client ID'), 'portal-ora');
    expect(label(form, 'Client-Secret').type).toBe('password');
    await type(label(form, 'Client-Secret'), 's3cret');
    await type(label(form, 'Scope'), 'api://ora/.default');
    await submit(form);
    expect(api).toHaveBeenCalledWith('/mcp-servers', {
      body: {
        name: 'Oracle', url: 'https://oracle-mcp.acme.example/mcp', transport: 'streamable-http', headers: undefined,
        oauth: { tokenUrl: 'https://idp.acme.example/token', clientId: 'portal-ora', clientSecret: 's3cret', scope: 'api://ora/.default' },
      },
    });
  });

  it('a header value typed before switching to OAuth is not sent', async () => {
    backend({ servers: [], tokens: [] });
    await dom.render(<McpSettings />);
    const form = dom.$$<HTMLFormElement>('form')[0];
    await type(label(form, 'Header-Wert'), 'Bearer leaked');
    await type(label(form, 'Anmeldung'), 'oauth');
    await type(label(form, 'Name'), 'X');
    await type(label(form, 'URL'), 'https://x.acme.example/mcp');
    await type(label(form, 'Token-URL'), 'https://idp.acme.example/token');
    await type(label(form, 'Client ID'), 'c');
    await type(label(form, 'Client-Secret'), 's');
    await submit(form);
    const body = api.mock.calls.find(([p, init]) => p === '/mcp-servers' && init?.body)![1].body;
    expect(body.headers).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('leaked');
  });
});
