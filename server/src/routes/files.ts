import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { attachments } from '../db/schema.js';
import { audit } from '../audit.js';
import { extractTextFrom, isImage } from '../extract.js';

export const filesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024, files: 10 } });

filesRouter.post('/', upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) return res.status(400).json({ error: 'Keine Datei' });
  const out = [];
  for (const f of files) {
    const filename = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer decodes as latin1
    let text: string | null = null;
    let warning: string | undefined;
    try {
      text = await extractTextFrom(filename, f.mimetype, f.buffer);
    } catch (e) {
      warning = `Text konnte nicht extrahiert werden: ${(e as Error).message}`;
    }
    if (!text && !isImage(f.mimetype) && !warning) warning = 'Dateityp wird nicht unterstützt – Inhalt wird dem Modell nicht übergeben';
    const [row] = await db.insert(attachments).values({
      userId: req.user!.id, filename, mimeType: f.mimetype, size: f.size,
      sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer, extractedText: text,
    }).returning({ id: attachments.id, filename: attachments.filename, mimeType: attachments.mimeType, size: attachments.size, sha256: attachments.sha256 });
    await audit(req, { action: 'file.upload', targetType: 'file', targetId: row.id, details: { filename, size: f.size, mime: f.mimetype, sha256: row.sha256 } });
    out.push({ ...row, hasText: !!text, isImage: isImage(f.mimetype), warning });
  }
  res.status(201).json(out);
});

filesRouter.get('/:id', async (req, res) => {
  const [f] = await db.select().from(attachments).where(and(eq(attachments.id, req.params.id), eq(attachments.userId, req.user!.id)));
  if (!f) return res.status(404).end();
  await audit(req, { action: 'file.download', targetType: 'file', targetId: f.id, details: { filename: f.filename } });
  res.setHeader('content-type', f.mimeType);
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(f.data);
});
