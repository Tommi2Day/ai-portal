import { Router } from 'express';
import { z } from 'zod';
import type { PortalPlugin } from './types.js';

const input = z.object({ text: z.string().min(1).max(10_000).refine((value) => !!value.trim()) });
const count = (text: string) => ({
  words: text.trim().split(/\s+/u).length,
  characters: [...text].length,
});

const router = Router();
router.post('/count', (req, res) => {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: parsed.error.issues });
  res.json(count(parsed.data.text));
});

export const samplePlugin: PortalPlugin = {
  id: 'text-stats',
  name: 'Text-Statistik',
  description: 'Zählt Wörter und Zeichen in einem Text.',
  hasPage: true,
  router,
  tools: {
    count_text: {
      description: 'Zähle Wörter und Zeichen in einem Text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 10_000, description: 'Text zum Zählen' } },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (value) => count(input.parse(value).text),
    },
  },
};
