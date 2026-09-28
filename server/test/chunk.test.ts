import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/knowledge/chunk.js';

const body = (c: string, title: string) => {
  expect(c.startsWith(`${title}\n\n`)).toBe(true);
  return c.slice(title.length + 2);
};

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('', 'T')).toEqual([]);
    expect(chunkText(' \n\r\n\t ', 'T')).toEqual([]);
  });

  it('keeps short text in one chunk prefixed with the title', () => {
    expect(chunkText('First paragraph.\n\nSecond paragraph.', 'Runbook')).toEqual(['Runbook\n\nFirst paragraph.\n\nSecond paragraph.']);
  });

  it('normalizes line endings, trailing blanks and blank-line runs', () => {
    expect(chunkText('a  \r\nb\n\n\n\nc', 'T')).toEqual(['T\n\na\nb\n\nc']);
  });

  it('respects the maximum size and splits at paragraph boundaries', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(80));
    const chunks = chunkText(paras.join('\n\n'), 'T', 300, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(body(c, 'T').length).toBeLessThanOrEqual(300 + 50 + 2);
    // every paragraph appears completely in at least one chunk
    for (const p of paras) expect(chunks.some((c) => c.includes(p))).toBe(true);
  });

  it('carries an overlap from the previous chunk', () => {
    const paras = ['alpha '.repeat(40).trim(), 'bravo '.repeat(40).trim(), 'charlie '.repeat(30).trim()];
    const chunks = chunkText(paras.join('\n\n'), 'T', 300, 60);
    expect(chunks.length).toBe(3);
    expect(body(chunks[1], 'T')).toMatch(/^(alpha ?)+\n\nbravo/);
    expect(body(chunks[2], 'T')).toMatch(/^(bravo ?)+\n\ncharlie/);
  });

  it('splits long paragraphs at sentence boundaries', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`);
    const chunks = chunkText(sentences.join(' '), 'T', 120, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const s of sentences) expect(chunks.some((c) => c.includes(s))).toBe(true);
  });

  it('hard-cuts a single overlong word', () => {
    const chunks = chunkText('y'.repeat(1000), 'T', 300, 0);
    expect(chunks.map((c) => body(c, 'T')).join('').replace(/\s/g, '')).toBe('y'.repeat(1000));
    for (const c of chunks) expect(body(c, 'T').length).toBeLessThanOrEqual(300);
  });

  it('starts a new piece at Markdown headings', () => {
    const chunks = chunkText(`Intro text.\n# Heading\n${'z'.repeat(250)}`, 'T', 200, 0);
    expect(chunks.some((c) => body(c, 'T').startsWith('# Heading'))).toBe(true);
  });
});

describe('trimSlashes', () => {
  it('removes trailing slashes only', async () => {
    const { trimSlashes } = await import('../src/knowledge/connectors/types.js');
    expect(trimSlashes('https://wiki.acme.example/confluence///')).toBe('https://wiki.acme.example/confluence');
    expect(trimSlashes('/sites/it/')).toBe('/sites/it');
    expect(trimSlashes('/')).toBe('');
    expect(trimSlashes('no-slash')).toBe('no-slash');
  });
});
