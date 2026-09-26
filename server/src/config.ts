import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DATABASE_URL: z.string().default('postgres://aiportal:aiportal@localhost:5432/aiportal'),
  /** Signs session JWTs. >= 32 chars. */
  SESSION_SECRET: z.string().min(32),
  /** 32-byte key (base64) for AES-256-GCM encryption of provider keys / MCP credentials. */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: bool,
  STATIC_DIR: z.string().default('../web/dist'),
  LOG_LEVEL: z.string().default('info'),

  // Bootstrap admin (only created if no user exists yet)
  BOOTSTRAP_ADMIN_USER: z.string().default('admin'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  // Local login
  AUTH_LOCAL_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // LDAP / Active Directory
  LDAP_ENABLED: bool,
  LDAP_URL: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_SEARCH_BASE: z.string().optional(),
  /** {{username}} is replaced (escaped). AD example: (sAMAccountName={{username}}) */
  LDAP_SEARCH_FILTER: z.string().default('(uid={{username}})'),
  LDAP_ATTR_DISPLAYNAME: z.string().default('displayName'),
  LDAP_ATTR_EMAIL: z.string().default('mail'),
  /** Members of this group DN become admins. */
  LDAP_ADMIN_GROUP_DN: z.string().optional(),
  /** If set, only members of this group may log in. */
  LDAP_USER_GROUP_DN: z.string().optional(),
  /** Where to look up group memberships (member=<userDN>) if the user entry has no memberOf. */
  LDAP_GROUP_SEARCH_BASE: z.string().optional(),
  LDAP_TLS_REJECT_UNAUTHORIZED: z.string().default('true').transform((v) => v === 'true'),

  // OIDC (Azure AD / Entra ID, Keycloak, ...)
  OIDC_ENABLED: bool,
  OIDC_ISSUER: z.string().optional(), // Azure: https://login.microsoftonline.com/<tenant>/v2.0
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_DISPLAY_NAME: z.string().default('Microsoft'),
  /** Claim holding groups/roles, e.g. "roles" (Azure app roles) or "groups". */
  OIDC_ROLE_CLAIM: z.string().default('roles'),
  OIDC_ADMIN_VALUE: z.string().optional(), // e.g. "AiPortal.Admin"
  /** Claim with group names used for knowledge-base access (Azure: configure "groups" claim, or use app roles). */
  OIDC_GROUP_CLAIM: z.string().default('groups'),
  OIDC_USER_VALUE: z.string().optional(), // if set, required to log in

  // Limits
  UPLOAD_MAX_MB: z.coerce.number().default(20),
  MAX_TOOL_STEPS: z.coerce.number().default(8),
  AUDIT_LOG_PROMPTS: bool, // store full prompt text in audit details
  // Knowledge base
  KNOWLEDGE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  /** Run the background sync scheduler in this process (set false on pure web pods if you run a separate worker). */
  KNOWLEDGE_WORKER: z.string().default('true').transform((v) => v === 'true'),
  /** Mount root for "filesystem" sources (SMB/NFS share mounted into the pod). Paths outside are rejected. */
  KNOWLEDGE_FS_ROOT: z.string().default('/data/shares'),
  KNOWLEDGE_MAX_FILE_MB: z.coerce.number().default(50),
  MCP_ALLOW_PRIVATE_NETWORKS: z.string().default('true').transform((v) => v === 'true'),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
