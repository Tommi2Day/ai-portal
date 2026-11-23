import crypto from 'node:crypto';
import { htmlToText } from 'html-to-text';
import { config } from '../../config.js';
import { extractTextFrom, KNOWLEDGE_EXT } from '../../extract.js';
import type { Connector, DocRef } from './types.js';

export interface HttpConfig {
  /** Pages to start from (http/https). */
  startUrls: string[];
  /** Default true: follow links to subpages. false: only the start URLs. */
  includeSubpages?: boolean;
  /** Link depth below the start URLs (1 = pages linked from them); 0 = unlimited (still bounded by maxPages). Default 3. */
  maxDepth?: number;
  /** Upper limit of pages per sync. Default 200. */
  maxPages?: number;
  /** Links are followed only below this path of the same host. Default: the directory of each start URL. */
  pathPrefix?: string;
  /** URLs containing one of these strings are skipped. */
  exclude?: string[];
}
/** Request headers sent to the site, e.g. { Authorization: "Bearer …" } or { Cookie: "…" } (write-only). */
export type HttpSecret = Record<string, string>;

export const HTTP_DEFAULTS = { maxDepth: 3, maxPages: 200 } as const;
const MAX_REDIRECTS = 5;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|eot|zip|gz|tgz|7z|rar|mp[34]|avi|mov|exe|dmg|iso)$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Canonical form for de-duplication: no fragment, no default port, "." / ".." resolved. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

/** href values of <a> elements (regex instead of a DOM: pages can be large and malformed). */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push((m[1] ?? m[2] ?? m[3] ?? '').replaceAll('&amp;', '&').trim());
  return out;
}

function metaRobots(html: string) {
  const m = /<meta\s[^>]*name\s*=\s*["']robots["'][^>]*>/i.exec(html);
  const content = m ? /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1].toLowerCase() ?? '' : '';
  return { noindex: content.includes('noindex') || content.includes('none'), nofollow: content.includes('nofollow') || content.includes('none') };
}

function pageTitle(html: string, fallback: string) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '';
  const text = htmlToText(t, { wordwrap: false }).replaceAll(/\s+/g, ' ').trim();
  return text || fallback;
}

/** Page text without navigation, footers and scripts. */
function pageText(html: string) {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }, { selector: 'table', format: 'dataTable' },
      { selector: 'nav', format: 'skip' }, { selector: 'footer', format: 'skip' }, { selector: 'aside', format: 'skip' },
      { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }, { selector: 'noscript', format: 'skip' }, { selector: 'form', format: 'skip' },
    ],
  });
}

export function httpConnector(cfg: HttpConfig, headers: HttpSecret = {}): Connector {
  const includeSubpages = cfg.includeSubpages !== false;
  const maxDepth = cfg.maxDepth === undefined ? HTTP_DEFAULTS.maxDepth : cfg.maxDepth;
  const maxPages = cfg.maxPages ?? HTTP_DEFAULTS.maxPages;
  const maxBytes = config.KNOWLEDGE_MAX_FILE_MB * 1024 * 1024;
  const starts = cfg.startUrls.map((u) => normalizeUrl(u)).filter((u): u is string => !!u);
  const exclude = (cfg.exclude ?? []).filter(Boolean);

  /** Scope = same origin and below the path prefix of a start URL. Credentials only ever go to these hosts. */
  const scopes = starts.map((u) => {
    const url = new URL(u);
    const prefix = cfg.pathPrefix ?? url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    return { origin: url.origin, prefix: prefix.startsWith('/') ? prefix : `/${prefix}` };
  });
  const inScope = (u: string) => {
    const url = new URL(u);
    return scopes.some((s) => s.origin === url.origin && url.pathname.startsWith(s.prefix)) && !exclude.some((x) => u.includes(x));
  };

  /** One GET; transient errors (429/5xx) are retried up to 3 times, honoring Retry-After. */
  async function fetchRetrying(url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'ai-portal-knowledge-crawler', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (![429, 502, 503, 504].includes(res.status) || attempt >= 3) return res;
      await sleep(Math.min((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000, 30_000));
    }
  }

  /** GET with manual redirects: every hop must stay in scope (no leaving the site, no credentials to other hosts). */
  async function fetchPage(start: string): Promise<{ res: Response; url: string } | { skip: string }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchRetrying(url);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = normalizeUrl(location, url);
        if (!next) return { skip: 'ungültige Weiterleitung' };
        if (!inScope(next)) return { skip: `Weiterleitung nach ${new URL(next).origin}${new URL(next).pathname} außerhalb des erlaubten Bereichs (Login-Seite?)` };
        url = next;
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url.replace(/\?.*/, '')}: HTTP ${res.status}`);
      return { res, url };
    }
    return { skip: 'zu viele Weiterleitungen' };
  }

  const isStart = new Set(starts);

  interface Page { url: string; type: string; filename: string; modifiedAt: Date | null; etag: string | null; lastModified: string | null; buf: Buffer; isHtml: boolean }

  /** Fetches a page and decides whether it is indexable (HTML or a document, within the size limit); null = skip it. */
  async function readPage(url: string): Promise<Page | null> {
    const r = await fetchPage(url).catch((e) => { if (isStart.has(url)) throw e; return { skip: String(e.message ?? e) }; });
    if ('skip' in r) {
      if (isStart.has(url)) throw new Error(`${url}: ${r.skip}`);
      return null;
    }
    const type = (r.res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const finalPath = new URL(r.url).pathname;
    const isHtml = type === 'text/html' || type === 'application/xhtml+xml';
    const isDoc = !isHtml && (type.startsWith('text/') || KNOWLEDGE_EXT.test(finalPath));
    if (!isHtml && !isDoc) return null;
    const buf = Buffer.from(await r.res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const lastModified = r.res.headers.get('last-modified');
    return {
      url: r.url, type, buf, isHtml, lastModified,
      filename: decodeURIComponent(finalPath.split('/').filter(Boolean).pop() ?? 'index.html'),
      modifiedAt: lastModified && !Number.isNaN(Date.parse(lastModified)) ? new Date(lastModified) : null,
      etag: r.res.headers.get('etag'),
    };
  }

  /** Adds the in-scope links of an HTML page to the crawl queue. */
  function enqueueLinks(html: string, page: Page, depth: number, seen: Set<string>, queue: { url: string; depth: number }[]) {
    for (const href of extractLinks(html)) {
      const next = normalizeUrl(href, page.url);
      if (!next || seen.has(next) || SKIP_EXT.test(new URL(next).pathname) || !inScope(next)) continue;
      seen.add(next);
      queue.push({ url: next, depth: depth + 1 });
    }
  }

  function htmlRef(page: Page, text: string, title: string): DocRef {
    return {
      externalId: page.url, title, filename: page.filename, mimeType: 'text/html', url: page.url, modifiedAt: page.modifiedAt,
      version: page.etag ?? page.lastModified ?? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
      load: async () => ({ text }),
    };
  }

  function fileRef(page: Page): DocRef {
    const { filename, type, buf } = page;
    return {
      externalId: page.url, title: filename, filename, mimeType: type || null, url: page.url, modifiedAt: page.modifiedAt, size: buf.length,
      version: page.etag ?? page.lastModified ?? crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
      load: async () => {
        const text = await extractTextFrom(filename, type, buf);
        if (!text) throw new Error('Kein Text extrahierbar');
        return { text };
      },
    };
  }

  return {
    async *list() {
      if (!starts.length) throw new Error('Keine gültige Start-URL');
      const seen = new Set<string>();
      const queue = starts.map((url) => ({ url, depth: 0 }));
      for (const q of queue) seen.add(q.url);
      let yielded = 0;

      while (queue.length && yielded < maxPages) {
        const { url, depth } = queue.shift()!;
        const page = await readPage(url);
        if (!page) continue;
        if (!page.isHtml) {
          yielded++;
          yield fileRef(page);
          continue;
        }
        const html = page.buf.toString('utf8');
        const robots = metaRobots(html);
        if (includeSubpages && !robots.nofollow && (maxDepth === 0 || depth < maxDepth)) enqueueLinks(html, page, depth, seen, queue);
        if (robots.noindex) continue;
        const title = pageTitle(html, page.filename);
        yielded++;
        yield htmlRef(page, `# ${title}\n\n${pageText(html)}`, title);
      }
    },
  };
}
