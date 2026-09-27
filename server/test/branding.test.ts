import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { escapeHtml, loadBranding, logoDataUri, logoOrigin, renderIndexHtml } from '../src/branding.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-portal-branding-'));
const file = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const TEMPLATE = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <title>AI Portal</title>
    <link rel="stylesheet" href="/assets/index.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('escapeHtml', () => {
  it('escapes all HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('logoDataUri', () => {
  it('embeds a file as base64 data URI with the matching MIME type', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(logoDataUri(file('logo.svg', svg))).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    expect(logoDataUri(file('logo.PNG', Buffer.from([1, 2, 3])))).toBe('data:image/png;base64,AQID');
    expect(logoDataUri(file('logo.jpeg', 'x'))).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects unsupported file types', () => {
    expect(() => logoDataUri(file('logo.bmp', 'x'))).toThrow(/unsupported logo type "\.bmp"/);
  });
});

describe('loadBranding', () => {
  it('uses the defaults without configuration', () => {
    expect(loadBranding({})).toEqual({ name: 'AI Portal' });
    expect(loadBranding({ PORTAL_NAME: '   ' })).toEqual({ name: 'AI Portal' });
  });

  it('reads name, theme stylesheet and logo file', () => {
    const css = ':root { --accent: #00857c; }';
    const b = loadBranding({
      PORTAL_NAME: ' ACME AI Portal ',
      PORTAL_THEME_CSS: file('theme.css', css),
      PORTAL_LOGO: file('brand.svg', '<svg/>'),
    });
    expect(b.name).toBe('ACME AI Portal');
    expect(b.css).toBe(css);
    expect(b.logoSrc).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('keeps an http(s) logo URL as is', () => {
    expect(loadBranding({ PORTAL_LOGO: 'https://cdn.acme.example/logo.png' }).logoSrc).toBe('https://cdn.acme.example/logo.png');
  });

  it('skips unreadable or unsupported files instead of failing', () => {
    const b = loadBranding({ PORTAL_THEME_CSS: path.join(dir, 'missing.css'), PORTAL_LOGO: file('logo.tiff', 'x') });
    expect(b).toEqual({ name: 'AI Portal' });
  });
});

describe('logoOrigin', () => {
  it('returns the origin of an external logo (for the CSP img-src)', () => {
    expect(logoOrigin({ name: 'x', logoSrc: 'https://cdn.acme.example:8443/a/logo.png' })).toBe('https://cdn.acme.example:8443');
  });

  it('returns undefined for data URIs and without logo', () => {
    expect(logoOrigin({ name: 'x', logoSrc: 'data:image/png;base64,AA==' })).toBeUndefined();
    expect(logoOrigin({ name: 'x' })).toBeUndefined();
  });
});

describe('renderIndexHtml', () => {
  it('sets title and name meta tag without logo or theme', () => {
    const html = renderIndexHtml(TEMPLATE, { name: 'AI Portal' });
    expect(html).toContain('<title>AI Portal</title>');
    expect(html).toContain('<meta name="portal-name" content="AI Portal">');
    expect(html).not.toContain('portal-logo');
    expect(html).not.toContain('portal-theme');
  });

  it('escapes the name in title and meta tag', () => {
    const html = renderIndexHtml(TEMPLATE, { name: 'A&B <Portal> "x"' });
    expect(html).toContain('<title>A&amp;B &lt;Portal&gt; &quot;x&quot;</title>');
    expect(html).toContain('content="A&amp;B &lt;Portal&gt; &quot;x&quot;"');
  });

  it('injects logo meta tag and theme after the built-in stylesheet', () => {
    const html = renderIndexHtml(TEMPLATE, { name: 'ACME', logoSrc: 'https://cdn.acme.example/logo.svg?a=1&b=2', css: ':root{--accent:red}' });
    expect(html).toContain('<meta name="portal-logo" content="https://cdn.acme.example/logo.svg?a=1&amp;b=2">');
    const theme = html.indexOf('<style id="portal-theme">');
    expect(theme).toBeGreaterThan(html.indexOf('/assets/index.css'));
    expect(theme).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain(':root{--accent:red}');
  });

  it('inserts replacement patterns like $& literally', () => {
    const html = renderIndexHtml(TEMPLATE, { name: 'Cost $& Co', css: 'a::after { content: "$\'"; }' });
    expect(html).toContain('<title>Cost $&amp; Co</title>');
    expect(html).toContain('a::after { content: "$\'"; }');
  });
});
