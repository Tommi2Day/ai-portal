import type { SessionUser } from './auth/session.js';
declare global {
  namespace Express {
    interface Request { user?: SessionUser }
  }
}
export {};
