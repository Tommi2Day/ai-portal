/**
 * Web UI branding: corporate name, logo and colors.
 *
 *   PORTAL_NAME      – name in the top bar, on the sign-in page and in the browser tab
 *   PORTAL_THEME_CSS – CSS file appended after the built-in styles (override the :root variables)
 *   PORTAL_LOGO      – logo file (svg/png/jpg/gif/webp, embedded as data URI) or http(s) URL
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

export interface Branding {
  name: string;
  /** Additional stylesheet, injected after the built-in one. */
  css?: string;
  /** Logo `src` (data URI or URL), shown next to the name. */
  logoSrc?: string;
}

const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Converts a logo file into a data URI; throws on unsupported file types. */
export function logoDataUri(file: string): string {
  const mime = LOGO_TYPES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`unsupported logo type "${path.extname(file)}" (use ${Object.keys(LOGO_TYPES).join(', ')})`);
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Reads PORTAL_NAME / PORTAL_THEME_CSS / PORTAL_LOGO; unreadable files are logged and skipped (built-in design). */
export function loadBranding(env: NodeJS.ProcessEnv = process.env): Branding {
  const branding: Branding = { name: env.PORTAL_NAME?.trim() || 'AI Portal' };
  if (env.PORTAL_THEME_CSS) {
    try {
      branding.css = fs.readFileSync(env.PORTAL_THEME_CSS, 'utf8');
      logger.info({ file: env.PORTAL_THEME_CSS }, 'web UI theme loaded');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'PORTAL_THEME_CSS ignored');
    }
  }
  if (env.PORTAL_LOGO) {
    try {
      branding.logoSrc = /^https?:\/\//i.test(env.PORTAL_LOGO) ? env.PORTAL_LOGO : logoDataUri(env.PORTAL_LOGO);
      logger.info({ logo: env.PORTAL_LOGO }, 'web UI logo loaded');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'PORTAL_LOGO ignored');
    }
  }
  return branding;
}

/** Origin of an external logo URL (needed in the CSP img-src), undefined for data URIs. */
export function logoOrigin(branding: Branding): string | undefined {
  if (!branding.logoSrc || !/^https?:\/\//i.test(branding.logoSrc)) return undefined;
  try { return new URL(branding.logoSrc).origin; } catch { return undefined; }
}

/**
 * Fills the built index.html: title, name/logo as <meta> tags (read by the SPA, no inline script
 * needed under the CSP) and the optional theme stylesheet after the built-in one.
 */
export function renderIndexHtml(template: string, branding: Branding): string {
  const name = escapeHtml(branding.name);
  let head = `<meta name="portal-name" content="${name}">\n`;
  if (branding.logoSrc) head += `<meta name="portal-logo" content="${escapeHtml(branding.logoSrc)}">\n`;
  if (branding.css) head += `<style id="portal-theme">\n${branding.css}\n</style>\n`;
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`)
    .replace('</head>', () => `${head}</head>`);
}
