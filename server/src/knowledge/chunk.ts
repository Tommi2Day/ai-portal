/** Normalizes line endings, trailing blanks and runs of empty lines. */
const normalize = (text: string) =>
  text.replaceAll('\r', '').split('\n').map((l) => l.trimEnd()).join('\n').replaceAll(/\n{3,}/g, '\n\n').trim();

/** Cuts a string into slices of at most maxChars. */
const hardCut = (s: string, maxChars: number) => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  return out;
};

/** A paragraph longer than maxChars -> sentences, packed up to maxChars; over-long sentences are cut hard. */
function splitParagraph(p: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const s of p.split(/(?<=[.!?])\s+/)) {
    if (buf && (buf + ' ' + s).length > maxChars) { out.push(buf); buf = ''; }
    if (s.length > maxChars) out.push(...hardCut(s, maxChars));
    else buf = buf ? `${buf} ${s}` : s;
  }
  if (buf) out.push(buf);
  return out;
}

/** Start of the next chunk: the last `overlap` characters of the previous one, beginning at a word boundary. */
const carryOver = (prev: string, overlap: number) => (overlap > 0 ? prev.slice(-overlap).replace(/^\S*\s/, '') + '\n\n' : '');

/** Packs pieces into chunks of at most ~maxChars, each starting with an overlap from the previous chunk. */
function pack(pieces: string[], maxChars: number, overlap: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      chunks.push(cur);
      cur = carryOver(cur, overlap) + p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Splits text into overlapping chunks of ~maxChars (~600 tokens), preferring
 * heading / paragraph / sentence boundaries. Each chunk is prefixed with the
 * document title so the embedding carries context.
 */
export function chunkText(text: string, title: string, maxChars = 2400, overlap = 300): string[] {
  const clean = normalize(text);
  if (!clean) return [];
  const pieces = clean.split(/\n(?=#{1,6} )|\n\n/).flatMap((p) => (p.length <= maxChars ? [p] : splitParagraph(p, maxChars)));
  return pack(pieces, maxChars, overlap).map((c) => `${title}\n\n${c}`);
}
