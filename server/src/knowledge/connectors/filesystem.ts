import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { KNOWLEDGE_EXT } from '../../extract.js';
import type { Connector, DocRef } from './types.js';

export interface FilesystemConfig {
  /** Relative to KNOWLEDGE_FS_ROOT, e.g. "it-handbuch" */
  path: string;
  recursive?: boolean;
  /** Optional prefix to build clickable links, e.g. "file://fileserver/it-handbuch/" or an intranet URL. */
  urlPrefix?: string;
  /** Glob-free exclusion: path segments to skip, e.g. ["Archiv", "~$"] */
  exclude?: string[];
}

/** Resolves a configured path and makes sure it stays inside KNOWLEDGE_FS_ROOT. */
export function resolveFsPath(p: string) {
  const root = path.resolve(config.KNOWLEDGE_FS_ROOT);
  const abs = path.resolve(root, p.replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Pfad liegt außerhalb von ${root}`);
  return abs;
}

export function filesystemConnector(cfg: FilesystemConfig): Connector {
  const base = resolveFsPath(cfg.path);
  const maxBytes = config.KNOWLEDGE_MAX_FILE_MB * 1024 * 1024;
  const excluded = (rel: string) => (cfg.exclude ?? []).some((e) => e && rel.split(path.sep).some((seg) => seg.includes(e)));

  async function* walk(dir: string): AsyncGenerator<DocRef> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs);
      if (e.name.startsWith('.') || e.name.startsWith('~$') || excluded(rel)) continue;
      if (e.isDirectory()) { if (cfg.recursive !== false) yield* walk(abs); continue; }
      if (!e.isFile() || !KNOWLEDGE_EXT.test(e.name)) continue;
      const st = await fs.stat(abs);
      if (st.size > maxBytes) continue;
      const relPosix = rel.split(path.sep).join('/');
      const relUrl = relPosix.split('/').map(encodeURIComponent).join('/');
      yield {
        externalId: relPosix,
        title: relPosix,
        filename: e.name,
        size: st.size,
        modifiedAt: st.mtime,
        version: `${Math.floor(st.mtimeMs)}-${st.size}`,
        url: cfg.urlPrefix ? cfg.urlPrefix.replace(/\/?$/, '/') + relUrl : null,
        load: async () => ({ data: await fs.readFile(abs) }),
      };
    }
  }
  return { list: () => walk(base) };
}
