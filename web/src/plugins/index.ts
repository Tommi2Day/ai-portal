import type { ComponentType } from 'react';
import { TextStats } from './TextStats';

// Bundle trusted plugin pages here; IDs must match server/src/plugins/index.ts.
export const pluginPages: Record<string, ComponentType> = {
  'text-stats': TextStats,
};
