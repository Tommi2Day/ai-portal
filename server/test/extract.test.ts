import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractTextFrom, htmlToHtmlText, isImage, KNOWLEDGE_EXT } from '../src/extract.js';

const zip = async (files: Record<string, string>) => {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: 'nodebuffer' });
};

describe('isImage', () => {
  it('accepts the image types models understand', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) expect(isImage(m), m).toBe(true);
    for (const m of ['image/svg+xml', 'image/tiff', 'application/pdf', 'text/plain']) expect(isImage(m), m).toBe(false);
  });
});

describe('extractTextFrom', () => {
  it('reads text, logs and code by MIME type or extension', async () => {
    expect(await extractTextFrom('notes.txt', 'text/plain', Buffer.from('Hallo Welt'))).toBe('Hallo Welt');
    expect(await extractTextFrom('app.log', 'application/octet-stream', Buffer.from('ERROR x'))).toBe('ERROR x');
    expect(await extractTextFrom('Main.java', 'application/octet-stream', Buffer.from('class A {}'))).toBe('class A {}');
    expect(await extractTextFrom('data', 'application/json', Buffer.from('{"a":1}'))).toBe('{"a":1}');
  });

  it('returns null for unknown binary files and images', async () => {
    expect(await extractTextFrom('archive.bin', 'application/octet-stream', Buffer.from([0, 1, 2]))).toBeNull();
    expect(await extractTextFrom('photo.png', 'image/png', Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('converts HTML to text', async () => {
    const text = await extractTextFrom('page.html', 'text/html', Buffer.from('<h1>Title</h1><p>Body <a href="https://x">link</a></p><img src="a.png">'));
    expect(text).toContain('TITLE');
    expect(text).toContain('Body link');
    expect(text).not.toContain('https://x');
    expect(text).not.toContain('a.png');
  });

  it('extracts slide texts from PPTX in slide order', async () => {
    const slide = (t: string) => `<p:sld><a:t>${t}</a:t><a:t>R&amp;D</a:t></p:sld>`;
    const data = await zip({ 'ppt/slides/slide10.xml': slide('Ten'), 'ppt/slides/slide2.xml': slide('Two'), 'ppt/slides/slide1.xml': slide('One') });
    const text = await extractTextFrom('deck.pptx', 'application/octet-stream', data);
    expect(text).toBe('## Folie 1\nOne R&D\n\n## Folie 2\nTwo R&D\n\n## Folie 3\nTen R&D');
  });

  it('extracts cells from XLSX including shared and inline strings', async () => {
    const data = await zip({
      'xl/sharedStrings.xml': '<sst><si><t>Host</t></si><si><t>Status</t></si><si><t>db01</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>OK &amp; up</t></is></c><c r="C2"><v>42</v></c></row>' +
        '</sheetData></worksheet>',
    });
    expect(await extractTextFrom('hosts.xlsx', 'application/octet-stream', data)).toBe('## sheet1\nHost | Status\ndb01 | OK & up | 42');
  });

  it('truncates very long text', async () => {
    const text = (await extractTextFrom('big.txt', 'text/plain', Buffer.from('a'.repeat(300_010))))!;
    expect(text.startsWith('a'.repeat(300_000))).toBe(true);
    expect(text).toMatch(/\[\.\.\. gekürzt, 10 Zeichen ausgelassen\]$/);
  });
});

describe('htmlToHtmlText', () => {
  it('keeps table content', () => {
    const text = htmlToHtmlText('<table><tr><th>Key</th><th>Value</th></tr><tr><td>FRA</td><td>400 GB</td></tr></table>');
    expect(text).toMatch(/KEY\s+VALUE/);
    expect(text).toMatch(/FRA\s+400 GB/);
  });
});

describe('KNOWLEDGE_EXT', () => {
  it('matches indexable documents only', () => {
    for (const f of ['a.pdf', 'b.DOCX', 'c.md', 'd.yaml', 'e.html']) expect(KNOWLEDGE_EXT.test(f), f).toBe(true);
    for (const f of ['a.exe', 'b.zip', 'c.png', 'd.docx.tmp']) expect(KNOWLEDGE_EXT.test(f), f).toBe(false);
  });
});
