import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
vi.mock('../src/availableModels', () => ({ useAvailable: () => ({ av: null }) }));
const { TextStats } = await import('../src/plugins/TextStats');
const { Admin } = await import('../src/Admin');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { api.mockReset(); setLang('en'); dom = mount(); });
afterEach(() => dom.unmount());

describe('deployed plugins', () => {
  it('runs the sample page through its namespaced API', async () => {
    api.mockResolvedValue({ words: 2, characters: 11 });
    await dom.render(<TextStats />);
    await type(dom.$<HTMLTextAreaElement>('textarea'), 'Hallo Welt!');
    await submit(dom.$('form'));
    expect(api).toHaveBeenCalledWith('/plugins/text-stats/count', { body: { text: 'Hallo Welt!' } });
    expect(dom.$('[role=status]').textContent).toContain('Words: 2');
  });

  it('shows admin enable/disable controls', async () => {
    let enabled = false;
    const changed = vi.fn();
    api.mockImplementation(async (path: string, init?: { body?: { enabled: boolean } }) => {
      if (path === '/admin/plugins') return [{ id: 'text-stats', name: 'Text-Statistik', description: 'Zählt Wörter und Zeichen in einem Text.', enabled, hasPage: true }];
      if (path === '/admin/plugins/text-stats') { enabled = init!.body!.enabled; return { enabled }; }
      return [];
    });
    await dom.render(<Admin me={{ id: 'admin', username: 'admin', displayName: null, role: 'admin', authSource: 'local' }} onPluginsChanged={changed} />);
    await click(dom.$$<HTMLButtonElement>('.seg button').find((b) => b.textContent === 'Plugins')!);
    const checkbox = dom.$<HTMLInputElement>('tbody input[type=checkbox]');
    expect(checkbox.checked).toBe(false);
    await click(checkbox);
    expect(api).toHaveBeenCalledWith('/admin/plugins/text-stats', { method: 'PATCH', body: { enabled: true } });
    expect(checkbox.checked).toBe(true);
    await click(checkbox);
    expect(api).toHaveBeenCalledWith('/admin/plugins/text-stats', { method: 'PATCH', body: { enabled: false } });
    expect(checkbox.checked).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
