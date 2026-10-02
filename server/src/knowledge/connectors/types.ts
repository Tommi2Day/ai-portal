export interface DocRef {
  externalId: string;
  title: string;
  url?: string | null;
  mimeType?: string | null;
  /** Change marker; unchanged -> not downloaded again. */
  version?: string | null;
  filename: string;
  size?: number;
  /** Last editor (display name) and modification time in the source, if known from the listing. */
  author?: string | null;
  modifiedAt?: Date | null;
  /** May add the author when the listing does not carry it. */
  load(): Promise<{ data?: Buffer; text?: string; author?: string | null }>;
}

export interface Connector {
  list(): AsyncIterable<DocRef>;
}

/** Removes trailing slashes (no regex: `/\/+$/` backtracks on long inputs). */
export function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** fetch with timeout and retry on 429/502/503/504 (honours Retry-After). */
export async function httpFetch(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (![429, 502, 503, 504].includes(res.status) || attempt >= tries) {
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(/\?.*/, '')}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res;
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
  }
}
