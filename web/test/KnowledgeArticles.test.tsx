import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
vi.mock('../src/availableModels', () => ({ useAvailable: () => ({ av: null }) }));
const { Knowledge } = await import('../src/Knowledge');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('en'); api.mockReset(); dom = mount(); });
afterEach(() => { dom.unmount(); });

describe('article review', () => {
  it('shows submitted text to admins and removes an approved article from the queue', async () => {
    const pending = [{ id: 'a1', title: 'VPN guide', body: 'Request access from IT.', author: 'bob', collection: 'Manuals', submittedAt: '2026-09-28T00:00:00Z' }];
    api.mockImplementation(async (path: string) => {
      if (path === '/admin/knowledge/embedding') return { settings: null, presets: {} };
      if (path === '/admin/providers' || path === '/admin/knowledge/collections') return [];
      if (path === '/admin/knowledge/articles') return [...pending];
      if (path === '/admin/knowledge/articles/a1/approve') { pending.length = 0; return { status: 'approved', documentId: 'd1' }; }
    });
    await dom.render(<Knowledge />);
    expect(dom.el.textContent).toContain('VPN guide');
    expect(dom.el.textContent).toContain('Request access from IT.');
    expect(dom.el.textContent).toContain('bob');

    await click(dom.$<HTMLButtonElement>('.review-article button.primary'));
    expect(api).toHaveBeenCalledWith('/admin/knowledge/articles/a1/approve', { method: 'POST' });
    expect(dom.el.textContent).toContain('No articles awaiting review.');
  });
});
