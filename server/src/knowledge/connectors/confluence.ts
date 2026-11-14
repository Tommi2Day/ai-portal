import { httpFetch, trimSlashes, type Connector, type DocRef } from './types.js';
import { htmlToHtmlText } from '../../extract.js';

export interface ConfluenceConfig {
  /** Cloud: https://firma.atlassian.net/wiki · Server/DC: https://confluence.firma.local */
  baseUrl: string;
  deployment: 'cloud' | 'server';
  /** Whole spaces. May be empty when rootPageIds is set. */
  spaceKeys: string[];
  /** Page trees: these pages (IDs as in the page URL) and, if includeSubpages, their descendants. */
  rootPageIds?: string[];
  /** Default true. false: spaces import only their top-level pages, page trees only the root pages. */
  includeSubpages?: boolean;
  /** Depth of page trees below the root page (1 = direct children only); 0 or unset = unlimited. */
  maxDepth?: number;
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
  const includeSubpages = cfg.includeSubpages !== false;

  const names = new Map<string, string | null>();
  async function accountName(id?: string): Promise<string | null> {
    if (!id) return null;
    if (!names.has(id)) {
      names.set(id, await get<{ displayName?: string }>(`/rest/api/user?accountId=${encodeURIComponent(id)}`)
        .then((u) => u.displayName ?? null, () => null));
    }
    return names.get(id) ?? null;
  }

  /* ---- Server/DC: REST API v1 ---- */
  type ServerPage = { id: string; title: string; version: { number: number; when?: string; by?: { displayName?: string } }; _links: { webui: string } };
  const serverRef = (p: ServerPage): DocRef => ({
    externalId: p.id, title: p.title, filename: `${p.id}.html`, mimeType: 'text/html', version: String(p.version.number),
    url: base + p._links.webui,
    author: p.version.by?.displayName ?? null, modifiedAt: p.version.when ? new Date(p.version.when) : null,
    load: async () => {
      const full = await get<{ body: { storage: { value: string } } }>(`/rest/api/content/${p.id}?expand=body.storage`);
      return { text: toText(p.title, full.body.storage.value) };
    },
  });

  /** Pages of a paged v1 listing (content of a space, children of a page). */
  async function* serverPages(path: string): AsyncGenerator<ServerPage> {
    let start = 0;
    for (;;) {
      const r = await get<{ results: ServerPage[]; size: number; limit: number }>(`${path}&limit=100&start=${start}`);
      yield* r.results;
      if (r.size < r.limit) break;
      start += r.size;
    }
  }

  /* ---- Cloud: REST API v2 (cursor pagination) ---- */
  type CloudPage = { id: string; title: string; version: { number: number; createdAt?: string; authorId?: string }; _links: { webui: string } };
  const cloudRef = (p: CloudPage): DocRef => ({
    externalId: p.id, title: p.title, filename: `${p.id}.html`, mimeType: 'text/html', version: String(p.version.number),
    url: base + p._links.webui,
    modifiedAt: p.version.createdAt ? new Date(p.version.createdAt) : null,
    // v2 lists only the account id of the last editor: resolve the name when the page is loaded
    load: async () => {
      const full = await get<{ body: { storage: { value: string } } }>(`/api/v2/pages/${p.id}?body-format=storage`);
      return { text: toText(p.title, full.body.storage.value), author: await accountName(p.version.authorId) };
    },
  });
  const origin = new URL(base).origin;

  async function* cloudPages<T>(first: string): AsyncGenerator<T> {
    let next: string | undefined = first;
    while (next) {
      const r: { results: T[]; _links?: { next?: string } } = await get(next);
      yield* r.results;
      // _links.next is relative to the site origin, e.g. "/wiki/api/v2/spaces/.../pages?cursor=..."
      next = r._links?.next ? origin + r._links.next : undefined;
    }
  }

  /** Whole space. Without subpages only the top-level pages (`depth=root`). */
  async function* space(key: string): AsyncGenerator<DocRef> {
    const depth = includeSubpages ? '' : '&depth=root';
    if (cfg.deployment === 'server') {
      for await (const p of serverPages(`/rest/api/content?spaceKey=${encodeURIComponent(key)}&type=page&status=current&expand=version${depth}`)) yield serverRef(p);
      return;
    }
    const sp = await get<{ results: { id: string }[] }>(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    if (!sp.results[0]) throw new Error(`Space ${key} nicht gefunden oder kein Zugriff`);
    for await (const p of cloudPages<CloudPage>(`/api/v2/spaces/${sp.results[0].id}/pages?limit=100&status=current${depth}`)) yield cloudRef(p);
  }

  /** One page and, breadth first, its descendants (limited by includeSubpages / maxDepth). */
  async function* tree(rootId: string): AsyncGenerator<DocRef> {
    const id = encodeURIComponent(rootId);
    const root = cfg.deployment === 'server'
      ? serverRef(await get<ServerPage>(`/rest/api/content/${id}?expand=version`))
      : cloudRef(await get<CloudPage>(`/api/v2/pages/${id}`));
    yield root;
    const limit = cfg.maxDepth && cfg.maxDepth > 0 ? cfg.maxDepth : Infinity;
    if (!includeSubpages || limit < 1) return;
    let level = [root.externalId];
    for (let depth = 1; depth <= limit && level.length; depth++) {
      const nextLevel: string[] = [];
      for (const parent of level) {
        const pid = encodeURIComponent(parent);
        if (cfg.deployment === 'server') {
          for await (const p of serverPages(`/rest/api/content/${pid}/child/page?expand=version`)) { nextLevel.push(p.id); yield serverRef(p); }
        } else {
          // the children listing has no version: read each child page for change detection
          for await (const c of cloudPages<{ id: string }>(`/api/v2/pages/${pid}/children?limit=100`)) {
            nextLevel.push(c.id);
            yield cloudRef(await get<CloudPage>(`/api/v2/pages/${encodeURIComponent(c.id)}`));
          }
        }
      }
      level = nextLevel;
    }
  }

  return {
    async *list() {
      const seen = new Set<string>(); // a page can be part of a space and of a tree, or of several trees
      const once = async function* (src: AsyncGenerator<DocRef>) {
        for await (const d of src) if (!seen.has(d.externalId)) { seen.add(d.externalId); yield d; }
      };
      for (const k of cfg.spaceKeys ?? []) yield* once(space(k));
      for (const r of cfg.rootPageIds ?? []) yield* once(tree(r));
    },
  };
}
