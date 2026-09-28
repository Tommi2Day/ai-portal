import { useEffect, useState } from 'react';
import { api } from './api';
import { t } from './i18n';

/** Model offered by a provider (AWS account or presets), GET /admin/providers/:id/available-models */
export interface AvailableModel {
  modelId: string; displayName: string; kind: 'chat' | 'embedding'; supportsImages: boolean;
  via: 'profile' | 'region' | 'preset'; access: 'granted' | 'missing' | 'unknown'; legacy: boolean;
}
export interface Available { source: 'account' | 'presets'; models: AvailableModel[]; error?: string }

/** Option label in the model selection: name, geography of an inference profile, lifecycle and access status. */
export const availableLabel = (m: AvailableModel) =>
  [m.displayName, m.via === 'profile' ? `(${m.modelId.split('.')[0]})` : '', m.legacy ? t('– veraltet') : '', m.access === 'missing' ? t('– kein Modellzugriff') : '']
    .filter(Boolean).join(' ');

/** Loads the models a provider offers; `reload` bypasses the server cache. Empty providerId = nothing. */
export function useAvailable(providerId: string) {
  const [av, setAv] = useState<Available | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (refresh = false) => {
    if (!providerId) { setAv(null); return; }
    setLoading(true);
    api<Available>(`/admin/providers/${providerId}/available-models${refresh ? '?refresh=1' : ''}`)
      .then(setAv).catch((e) => setAv({ source: 'presets', models: [], error: (e as Error).message })).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [providerId]);
  return { av, loading, reload: () => load(true) };
}
