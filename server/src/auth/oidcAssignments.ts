import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { config } from '../config.js';

/**
 * SSO assignments managed in the admin UI (stored in `settings`), next to the OIDC_* environment lists.
 * - every entry grants access (group name / e-mail / `*@domain` / object id);
 * - `admin` additionally grants the admin role;
 * - entries without `admin` form the allow list: once one exists, other users are denied (admins always pass).
 *   Admin-only entries do not restrict anybody by themselves.
 */
export interface Assignment { type: 'group' | 'user'; value: string; admin: boolean; /** admin note, no effect on access */ comment?: string }

const KEY = 'oidc.assignments';
const TTL = 5_000; // other replicas pick changes up within seconds
let cache: { at: number; list: Assignment[] } | null = null;

export async function loadAssignments(): Promise<Assignment[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.list;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY));
  const list = Array.isArray(row?.value) ? (row.value as Assignment[]) : [];
  cache = { at: Date.now(), list };
  return list;
}

export async function saveAssignments(list: Assignment[]) {
  await db.insert(settings).values({ key: KEY, value: list, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: list, updatedAt: new Date() } });
  cache = { at: Date.now(), list };
}

const split = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Read-only entries from OIDC_ALLOWED_* / OIDC_ADMIN_* for display. */
export function envAssignments(): Assignment[] {
  return [
    ...split(config.OIDC_ALLOWED_GROUPS).map((value) => ({ type: 'group' as const, value, admin: false })),
    ...split(config.OIDC_ALLOWED_USERS).map((value) => ({ type: 'user' as const, value, admin: false })),
    ...split(config.OIDC_ADMIN_GROUPS).map((value) => ({ type: 'group' as const, value, admin: true })),
    ...split(config.OIDC_ADMIN_USERS).map((value) => ({ type: 'user' as const, value, admin: true })),
  ];
}
