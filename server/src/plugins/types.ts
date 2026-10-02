import type { Router } from 'express';
import type { JSONSchema7 } from 'ai';
import type { SessionUser } from '../auth/session.js';

export interface PluginTool {
  description: string;
  inputSchema: JSONSchema7;
  execute(input: unknown, user: SessionUser): Promise<unknown>;
}

/** Trusted modules are bundled with the server; routes receive an authenticated req.user. */
export interface PortalPlugin {
  id: string;
  name: string;
  description: string;
  hasPage?: boolean;
  router?: Router;
  tools?: Record<string, PluginTool>;
}
