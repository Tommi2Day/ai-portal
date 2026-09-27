/**
 * Starts the portal for the integration tests: fresh database on the portal-db container
 * (docker-compose.test.yml), temporary file-share root, portal process on a free port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    portalUrl: string;
    fsRoot: string;
    adminPassword: string;
  }
}

const ADMIN_URL = process.env.IT_PORTAL_DB_URL ?? 'postgres://aiportal:aiportal@127.0.0.1:55433/aiportal';
const ADMIN_PASSWORD = 'it-admin-password-123';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  }).on('error', reject);
});

async function waitFor(url: string, proc: ChildProcess, log: () => string, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`portal exited with ${proc.exitCode}\n${log()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`portal did not become ready\n${log()}`);
}

export default async function setup(project: TestProject) {
  const dbName = `aiportal_it_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try { await admin.connect(); } catch (e) {
    throw new Error(`portal-db not reachable at ${ADMIN_URL} – start it with: docker compose -f docker-compose.test.yml up -d --wait\n${e}`);
  }
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;

  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-portal-it-shares-'));
  // minimal built web UI + branding files (checks the index.html rendering in main.ts)
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-portal-it-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'),
    '<!doctype html><html><head><title>AI Portal</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>');
  fs.mkdirSync(path.join(webDir, 'assets'));
  fs.writeFileSync(path.join(webDir, 'assets', 'app.css'), 'body{}');
  fs.writeFileSync(path.join(webDir, 'theme.css'), ':root { --accent: #00857c; }');
  const port = await freePort();
  const logFile = path.join(os.tmpdir(), `ai-portal-it-${port}.log`);
  const out = fs.openSync(logFile, 'w');
  const serverDir = path.resolve(import.meta.dirname, '../..');
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: serverDir,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: dbUrl.toString(),
      SESSION_SECRET: 'integration-test-session-secret-0123456789',
      ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
      BOOTSTRAP_ADMIN_USER: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
      KNOWLEDGE_WORKER: 'false',
      KNOWLEDGE_FS_ROOT: fsRoot,
      STATIC_DIR: webDir,
      PORTAL_NAME: 'ACME AI Portal',
      PORTAL_THEME_CSS: path.join(webDir, 'theme.css'),
      PORTAL_LOGO: 'https://cdn.acme.example/logo.svg',
      LOG_LEVEL: 'info',
      NODE_ENV: 'test',
    },
  });
  const log = () => fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/readyz`, proc, log);

  project.provide('portalUrl', url);
  project.provide('fsRoot', fsRoot);
  project.provide('adminPassword', ADMIN_PASSWORD);

  return async () => {
    proc.kill();
    await new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)));
    fs.closeSync(out);
    if (process.env.IT_KEEP_DB !== '1') await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(fsRoot, { recursive: true, force: true });
    fs.rmSync(webDir, { recursive: true, force: true });
    if (process.env.IT_SHOW_LOG === '1') console.log(log());
  };
}
