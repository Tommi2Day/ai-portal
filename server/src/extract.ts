import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { convert as htmlToText } from 'html-to-text';

const xmlText = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((m) => decodeXml(m[1]));
const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function pptxText(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) out.push(`## Folie ${i + 1}\n` + xmlText(await zip.file(f)!.async('string'), 'a:t').join(' '));
  return out.join('\n\n');
}

async function xlsxText(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  const shared = zip.file('xl/sharedStrings.xml') ? [...(await zip.file('xl/sharedStrings.xml')!.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1], 't').join('')) : [];
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  const out: string[] = [];
  for (const f of sheets) {
    const xml = await zip.file(f)!.async('string');
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
      [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const inner = c[2] ?? '';
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        if (/t="s"/.test(c[1])) return shared[Number(v)] ?? '';
        return decodeXml(v ?? xmlText(inner, 't').join(''));
      }).join(' | '));
    out.push(`## ${f.replace(/^.*\//, '').replace('.xml', '')}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

const MAX_CHARS = 300_000;

const TEXT_EXT = /\.(txt|md|markdown|log|csv|tsv|json|ya?ml|xml|ini|conf|cfg|properties|env|sql|sh|bash|ps1|py|js|mjs|ts|tsx|jsx|java|kt|go|rs|c|h|cpp|hpp|cs|rb|php|swift|scala|tf|hcl|dockerfile|gradle|toml|out|err|trace)$/i;

export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/.test(mime);

/** Extracts text for the model context. Returns null for binary types we don't understand (and images). */
export async function extractTextFrom(filename: string, mime: string, data: Buffer): Promise<string | null> {
  let text: string | null = null;
  if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const r = await extractText(pdf, { mergePages: true });
    text = r.text as string;
  } else if (filename.toLowerCase().endsWith('.docx')) {
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else if (filename.toLowerCase().endsWith('.pptx')) {
    text = await pptxText(data);
  } else if (filename.toLowerCase().endsWith('.xlsx')) {
    text = await xlsxText(data);
  } else if (/\.html?$/i.test(filename) || mime === 'text/html') {
    text = htmlToHtmlText(data.toString('utf8'));
  } else if (mime.startsWith('text/') || TEXT_EXT.test(filename) || /json|xml|yaml|javascript/.test(mime)) {
    text = data.toString('utf8');
  }
  if (text && text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n\n[... gekürzt, ${text.length - MAX_CHARS} Zeichen ausgelassen]`;
  return text;
}

/** HTML / Confluence storage format -> readable text (keeps headings, lists, tables as text). */
export function htmlToHtmlText(html: string) {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }, { selector: 'table', format: 'dataTable' }],
  });
}

export const KNOWLEDGE_EXT = /\.(pdf|docx|pptx|xlsx|html?|txt|md|markdown|csv|json|ya?ml|xml|log|ini|conf|cfg|properties|sql|sh|ps1|py|js|ts|java|go|cs|rb|php)$/i;
