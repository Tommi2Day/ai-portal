import { z } from 'zod';

export const COMMENT_MAX = 300;

/**
 * Admin note on an entry (user, provider, model, knowledge collection or source): trimmed text up to
 * COMMENT_MAX characters. An empty text clears the note (stored as null), omitting the field leaves it unchanged.
 * Notes are admin-only: user-facing views select their columns explicitly and never include them.
 */
export const commentField = z.string().trim().max(COMMENT_MAX).transform((s) => s || null).optional();
