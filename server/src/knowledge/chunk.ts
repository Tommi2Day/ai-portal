/**
 * Splits text into overlapping chunks of ~maxChars (~600 tokens), preferring
 * heading / paragraph / sentence boundaries. Each chunk is prefixed with the
 * document title so the embedding carries context.
 */
export function chunkText(text: string, title: string, maxChars = 2400, overlap = 300): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n(?=#{1,6} )|\n\n/);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= maxChars) { pieces.push(p); continue; }
    // long paragraph -> sentences -> hard cut
    let buf = '';
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if ((buf + ' ' + s).length > maxChars && buf) { pieces.push(buf); buf = ''; }
      if (s.length > maxChars) { for (let i = 0; i < s.length; i += maxChars) pieces.push(s.slice(i, i + maxChars)); continue; }
      buf = buf ? `${buf} ${s}` : s;
    }
    if (buf) pieces.push(buf);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      chunks.push(cur);
      cur = overlap > 0 ? cur.slice(-overlap).replace(/^\S*\s/, '') + '\n\n' + p : p; // carry overlap from previous chunk
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `${title}\n\n${c}`);
}
