import {
  pgTable, uuid, text, boolean, timestamp, integer, jsonb, bigserial, pgEnum, customType, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
/** pgvector without fixed dimension; HNSW indexes are created per dimension at runtime (see knowledge/store.ts). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (v) => `[${v.join(',')}]`,
  fromDriver: (v) => JSON.parse(v),
});
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const authSource = pgEnum('auth_source', ['local', 'ldap', 'oidc']);
export const userRole = pgEnum('user_role', ['admin', 'user']);
export const providerType = pgEnum('provider_type', ['anthropic', 'bedrock', 'github', 'openai_compatible']);
export const mcpTransport = pgEnum('mcp_transport', ['streamable-http', 'sse']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull(),
  displayName: text('display_name'),
  email: text('email'),
  authSource: authSource('auth_source').notNull(),
  externalId: text('external_id'), // LDAP DN or OIDC "sub"
  passwordHash: text('password_hash'),
  role: userRole('role').notNull().default('user'),
  /** LDAP group CNs / OIDC group or role claims / admin-assigned for local users. Used for knowledge access. */
  groups: jsonb('groups').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  /** Self-registered local account waiting for admin approval (active stays false until then). */
  pendingApproval: boolean('pending_approval').notNull().default(false),
  /** False for freshly provisioned LDAP/OIDC users until they confirmed name and email. */
  profileCompleted: boolean('profile_completed').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
}, (t) => [uniqueIndex('users_username_uq').on(t.username)]);

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: providerType('type').notNull(),
  baseUrl: text('base_url'),
  region: text('region'),
  /** Non-secret provider options (e.g. GitHub org). */
  options: jsonb('options').$type<Record<string, string>>().notNull().default({}),
  /** AES-GCM encrypted JSON: { apiKey } or { accessKeyId, secretAccessKey, sessionToken } */
  secretEnc: text('secret_enc'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  supportsImages: boolean('supports_images').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  transport: mcpTransport('transport').notNull().default('streamable-http'),
  /** AES-GCM encrypted JSON object of HTTP headers (e.g. Authorization). */
  headersEnc: text('headers_enc'),
  enabled: boolean('enabled').notNull().default(true),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  toolCount: integer('tool_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('mcp_user_idx').on(t.userId)]);

export const chats = pgTable('chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Neuer Chat'),
  modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('chats_user_idx').on(t.userId, t.updatedAt)]);

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string; name: string; input: unknown; output?: unknown; error?: string };

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  role: text('role').$type<'user' | 'assistant'>().notNull(),
  content: text('content').notNull().default(''),
  parts: jsonb('parts').$type<MessagePart[]>().notNull().default([]),
  attachmentIds: jsonb('attachment_ids').$type<string[]>().notNull().default([]),
  modelId: uuid('model_id'),
  usage: jsonb('usage').$type<{ inputTokens?: number; outputTokens?: number }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_chat_idx').on(t.chatId, t.createdAt)]);

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  extractedText: text('extracted_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  username: text('username'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  success: boolean('success').notNull().default(true),
  ip: text('ip'),
  userAgent: text('user_agent'),
  details: jsonb('details').$type<Record<string, unknown>>(),
}, (t) => [index('audit_ts_idx').on(t.ts), index('audit_user_idx').on(t.userId, t.ts), index('audit_action_idx').on(t.action, t.ts)]);

/* ---------------- Settings ---------------- */

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Knowledge base (RAG) ---------------- */

export const knowledgeSourceType = pgEnum('knowledge_source_type', ['upload', 'filesystem', 'confluence', 'sharepoint']);

export const knowledgeCollections = pgTable('knowledge_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** Visible to everyone who is logged in. */
  public: boolean('public').notNull().default(false),
  /** Otherwise: visible to users having at least one of these groups (admins see all). */
  allowedGroups: jsonb('allowed_groups').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeSources = pgTable('knowledge_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id').notNull().references(() => knowledgeCollections.id, { onDelete: 'cascade' }),
  type: knowledgeSourceType('type').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  secretEnc: text('secret_enc'),
  /** 0 = manual only */
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  lastStats: jsonb('last_stats').$type<Record<string, number>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').notNull().references(() => knowledgeCollections.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  mimeType: text('mime_type'),
  /** Change marker from the source (mtime, version number, eTag). */
  version: text('version'),
  sha256: text('sha256'),
  size: integer('size'),
  /** Who wrote/last changed the document in the source (display name), where the source tells. */
  author: text('author'),
  /** Last modification in the source (not the time of indexing, see indexedAt). */
  modifiedAt: timestamp('modified_at', { withTimezone: true }),
  /** Extracted plain text. Originals are never stored – the source is linked via url where one exists. */
  text: text('text'),
  status: text('status').$type<'indexed' | 'error' | 'skipped'>().notNull().default('indexed'),
  error: text('error'),
  chunkCount: integer('chunk_count').notNull().default(0),
  embeddingModel: text('embedding_model'),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('kdoc_source_ext_uq').on(t.sourceId, t.externalId), index('kdoc_collection_idx').on(t.collectionId)]);

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding'),
  embeddingDim: integer('embedding_dim'),
  embeddingModel: text('embedding_model'),
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', content)`),
}, (t) => [
  index('kchunk_doc_idx').on(t.documentId),
  index('kchunk_collection_idx').on(t.collectionId),
  index('kchunk_tsv_idx').using('gin', t.tsv),
]);

export const knowledgeArticles = pgTable('knowledge_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  collectionId: uuid('collection_id').notNull().references(() => knowledgeCollections.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<'pending' | 'reviewing' | 'approved' | 'rejected'>().notNull().default('pending'),
  documentId: uuid('document_id').references(() => knowledgeDocuments.id, { onDelete: 'set null' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, (t) => [index('karticle_author_idx').on(t.authorId, t.submittedAt), index('karticle_status_idx').on(t.status, t.submittedAt)]);

/* ---------------- Personal access tokens (external MCP clients) ---------------- */

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** sha256 of the token; the token itself is shown once and never stored. */
  tokenHash: text('token_hash').notNull(),
  prefix: text('prefix').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash)]);

export type User = typeof users.$inferSelect;
export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type KnowledgeCollection = typeof knowledgeCollections.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Model = typeof models.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
