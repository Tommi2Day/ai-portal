import { httpFetch, trimSlashes, type Connector, type DocRef } from './types.js';
import { htmlToHtmlText } from '../../extract.js';

export interface ConfluenceConfig {
  /** Cloud: https://firma.atlassian.net/wiki · Server/DC: https://confluence.firma.local */
  baseUrl: string;
  deployment: 'cloud' | 'server';
  spaceKeys: string[];
}
/** Cloud: email + API token (Basic) · Server/DC: personal access token (Bearer) */
export interface ConfluenceSecret { email?: string; apiToken?: string; token?: string }

export function confluenceConnector(cfg: ConfluenceConfig, sec: ConfluenceSecret): Connector {
  const base = trimSlashes(cfg.baseUrl);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.deployment === 'cloud') headers.authorization = 'Basic ' + Buffer.from(`${sec.email}:${sec.apiToken}`).toString('base64');
  else headers.authorization = `Bearer ${sec.token}`;
  const get = async <T>(u: string) => (await (await httpFetch(u.startsWith('http') ? u : base + u, { headers })).json()) as T;
  const toText = (title: string, storage: string) => `# ${title}\n\n${htmlToHtmlText(storage)}`;

  /** Server/DC: REST API v1 */
  async function* server(space: string): AsyncGenerator<DocRef> {
    type Page = { id: string; title: string; version: { number: number }; _links: { webui: string } };
    let start = 0;
    for (;;) {
      const r = await get<{ results: Page[]; size: number; limit: number }>(
        `/rest/api/content?spaceKey=${encodeURIComponent(space)}&type=page&status=current&expand=version&limit=100&start=${start}`);
      for (const p of r.results) {
        yield {
          externalId: p.id, title: p.title, filename: `${p.id}.html`, mimeType: 'text/html', version: String(p.version.number),
          url: base + p._links.webui,
          load: async () => {
            const full = await get<{ body: { storage: { value: string } } }>(`/rest/api/content/${p.id}?expand=body.storage`);
            return { text: toText(p.title, full.body.storage.value) };
          },
        };
      }
      if (r.size < r.limit) break;
      start += r.size;
    }
  }

  /** Cloud: REST API v2 (cursor pagination) */
  async function* cloud(space: string): AsyncGenerator<DocRef> {
    const sp = await get<{ results: { id: string }[] }>(`/api/v2/spaces?keys=${encodeURIComponent(space)}`);
    if (!sp.results[0]) throw new Error(`Space ${space} nicht gefunden oder kein Zugriff`);
    type Page = { id: string; title: string; version: { number: number }; _links: { webui: string } };
    let next: string | undefined = `/api/v2/spaces/${sp.results[0].id}/pages?limit=100&status=current`;
    const origin = new URL(base).origin;
    while (next) {
      const r: { results: Page[]; _links?: { next?: string } } = await get(next);
      for (const p of r.results) {
        yield {
          externalId: p.id, title: p.title, filename: `${p.id}.html`, mimeType: 'text/html', version: String(p.version.number),
          url: base + p._links.webui,
          load: async () => {
            const full = await get<{ body: { storage: { value: string } } }>(`/api/v2/pages/${p.id}?body-format=storage`);
            return { text: toText(p.title, full.body.storage.value) };
          },
        };
      }
      // _links.next is relative to the site origin, e.g. "/wiki/api/v2/spaces/.../pages?cursor=..."
      next = r._links?.next ? origin + r._links.next : undefined;
    }
  }

  return {
    async *list() {
      for (const s of cfg.spaceKeys) yield* cfg.deployment === 'cloud' ? cloud(s) : server(s);
    },
  };
}
