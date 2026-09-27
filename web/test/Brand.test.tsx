import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Brand.tsx reads the <meta> tags once on import -> set them up, then import a fresh module
const setMeta = (name: string, content: string) => {
  const m = document.createElement('meta');
  m.name = name;
  m.content = content;
  document.head.append(m);
};
const load = async () => {
  vi.resetModules();
  return import('../src/Brand');
};

beforeEach(() => document.head.replaceChildren());
afterEach(() => document.head.replaceChildren());

describe('Brand', () => {
  it('falls back to "AI Portal" without server branding (vite dev)', async () => {
    const { Brand, portalName } = await load();
    expect(portalName).toBe('AI Portal');
    expect(renderToStaticMarkup(<Brand />)).toBe('<span class="brand"><span class="brand-name">AI Portal</span></span>');
  });

  it('uses name and logo injected by the server', async () => {
    setMeta('portal-name', 'ACME AI Portal');
    setMeta('portal-logo', 'data:image/svg+xml;base64,PHN2Zy8+');
    const { Brand, portalName } = await load();
    expect(portalName).toBe('ACME AI Portal');
    const html = renderToStaticMarkup(<Brand />);
    expect(html).toContain('class="brand has-logo"');
    expect(html).toContain('<img class="brand-logo" src="data:image/svg+xml;base64,PHN2Zy8+" alt=""/>');
    expect(html).toContain('<span class="brand-name">ACME AI Portal</span>');
  });

  it('ignores empty meta values', async () => {
    setMeta('portal-name', '');
    setMeta('portal-logo', '');
    const { Brand, portalName } = await load();
    expect(portalName).toBe('AI Portal');
    expect(renderToStaticMarkup(<Brand />)).not.toContain('<img');
  });

  it('escapes the name when rendering', async () => {
    setMeta('portal-name', '<b>ACME</b>');
    const { Brand } = await load();
    expect(renderToStaticMarkup(<Brand />)).toContain('&lt;b&gt;ACME&lt;/b&gt;');
  });
});
