import { httpFetch, type Connector, type DocRef } from './types.js';
import { KNOWLEDGE_EXT } from '../../extract.js';
import { config } from '../../config.js';

export interface SharePointConfig {
  tenantId: string;
  clientId: string;
  /** SharePoint site, e.g. https://firma.sharepoint.com/sites/IT — or: */
  siteUrl?: string;
  /** OneDrive of a user, e.g. max@firma.de */
  userPrincipalName?: string;
  /** Document library name (default: first library of the site) */
  driveName?: string;
  /** Optional sub folder, e.g. "Handbücher/Betrieb" */
  folderPath?: string;
  /** Overrides for national clouds / tests */
  graphBaseUrl?: string;
  loginBaseUrl?: string;
}
export interface SharePointSecret { clientSecret: string }

type Item = {
  id: string; name: string; webUrl: string; eTag?: string; cTag?: string; size?: number;
  file?: { mimeType?: string }; folder?: { childCount: number };
};

/**
 * Microsoft Graph with app-only auth (client credentials).
 * Required application permission: Sites.Selected (recommended, grant per site) or Sites.Read.All / Files.Read.All.
 */
export function sharepointConnector(cfg: SharePointConfig, sec: SharePointSecret): Connector {
  const graph = (cfg.graphBaseUrl ?? 'https://graph.microsoft.com').replace(/\/+$/, '') + '/v1.0';
  const login = (cfg.loginBaseUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  let token: { value: string; exp: number } | null = null;
  const maxBytes = config.KNOWLEDGE_MAX_FILE_MB * 1024 * 1024;

  async function auth() {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const body = new URLSearchParams({
      client_id: cfg.clientId, client_secret: sec.clientSecret, grant_type: 'client_credentials',
      scope: `${cfg.graphBaseUrl ? cfg.graphBaseUrl.replace(/\/+$/, '') : 'https://graph.microsoft.com'}/.default`,
    });
    const r = (await (await httpFetch(`${login}/${cfg.tenantId}/oauth2/v2.0/token`, { method: 'POST', body })).json()) as { access_token: string; expires_in: number };
    token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return token.value;
  }
  const get = async <T>(u: string): Promise<T> =>
    (await (await httpFetch(u.startsWith('http') ? u : graph + u, { headers: { authorization: `Bearer ${await auth()}` } })).json()) as T;

  async function driveId(): Promise<string> {
    if (cfg.userPrincipalName) return (await get<{ id: string }>(`/users/${encodeURIComponent(cfg.userPrincipalName)}/drive`)).id;
    if (!cfg.siteUrl) throw new Error('siteUrl oder userPrincipalName erforderlich');
    const u = new URL(cfg.siteUrl);
    const site = await get<{ id: string }>(`/sites/${u.hostname}:${u.pathname.replace(/\/+$/, '') || '/'}`);
    const drives = await get<{ value: { id: string; name: string }[] }>(`/sites/${site.id}/drives`);
    const d = cfg.driveName ? drives.value.find((x) => x.name === cfg.driveName) : drives.value[0];
    if (!d) throw new Error(`Bibliothek ${cfg.driveName ?? ''} nicht gefunden (vorhanden: ${drives.value.map((x) => x.name).join(', ')})`);
    return d.id;
  }

  async function* children(url: string, drive: string, prefix: string): AsyncGenerator<DocRef> {
    let next: string | undefined = url;
    while (next) {
      const r: { value: Item[]; '@odata.nextLink'?: string } = await get(next);
      for (const it of r.value) {
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.folder) { yield* children(`/drives/${drive}/items/${it.id}/children?$top=200`, drive, rel); continue; }
        if (!it.file || !KNOWLEDGE_EXT.test(it.name) || (it.size ?? 0) > maxBytes) continue;
        yield {
          externalId: it.id, title: rel, filename: it.name, url: it.webUrl, mimeType: it.file.mimeType ?? null,
          version: it.cTag ?? it.eTag ?? null, size: it.size,
          load: async () => {
            const res = await httpFetch(`${graph}/drives/${drive}/items/${it.id}/content`, { headers: { authorization: `Bearer ${await auth()}` } });
            return { data: Buffer.from(await res.arrayBuffer()) };
          },
        };
      }
      next = r['@odata.nextLink'];
    }
  }

  return {
    async *list() {
      const d = await driveId();
      const start = cfg.folderPath
        ? `/drives/${d}/root:/${cfg.folderPath.split('/').map(encodeURIComponent).join('/')}:/children?$top=200`
        : `/drives/${d}/root/children?$top=200`;
      yield* children(start, d, cfg.folderPath ?? '');
    },
  };
}
