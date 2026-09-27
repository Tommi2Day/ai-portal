/** Web UI delivery: branded index.html, SPA routes, static assets, CSP and health endpoints. */
import { describe, expect, it } from 'vitest';
import { portalUrl } from './helpers.js';

const get = (path: string) => fetch(portalUrl() + path);

describe('branded index.html', () => {
  it('serves the SPA with name, logo and theme on every UI route', async () => {
    for (const path of ['/', '/chat/123', '/index.html']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const html = await res.text();
      expect(html).toContain('<title>ACME AI Portal</title>');
      expect(html).toContain('<meta name="portal-name" content="ACME AI Portal">');
      expect(html).toContain('<meta name="portal-logo" content="https://cdn.acme.example/logo.svg">');
      expect(html).toMatch(/app\.css[^]*<style id="portal-theme">\n:root \{ --accent: #00857c; \}/);
    }
  });

  it('allows the external logo origin in the CSP img-src', async () => {
    const csp = (await get('/')).headers.get('content-security-policy')!;
    const img = csp.split(';').find((d) => d.trim().startsWith('img-src'))!;
    expect(img).toContain('https://cdn.acme.example');
    expect(csp).toMatch(/default-src 'self'/);
  });

  it('serves static assets and keeps /api out of the SPA fallback', async () => {
    expect(await (await get('/assets/app.css')).text()).toBe('body{}');
    const api = await get('/api/does-not-exist');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'not found' });
  });
});

describe('health endpoints', () => {
  it('reports liveness and database readiness', async () => {
    expect(await (await get('/healthz')).json()).toEqual({ ok: true });
    expect(await (await get('/readyz')).json()).toEqual({ ok: true });
  });
});
