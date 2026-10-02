import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api, ApiError: class ApiError extends Error { constructor(readonly status: number) { super(); } } }));
const { Articles } = await import('../src/Articles');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('en'); api.mockReset(); dom = mount(); });
afterEach(() => { dom.unmount(); });

describe('Articles', () => {
  it('submits Markdown to an accessible collection and displays review status', async () => {
    const articles: object[] = [];
    api.mockImplementation(async (path: string, init?: { body?: { collectionId: string; title: string; body: string } }) => {
      if (path === '/knowledge/collections') return { enabled: true, collections: [{ id: 'c1', name: 'Manuals' }] };
      if (path === '/knowledge/articles' && !init) return articles;
      if (path === '/knowledge/articles' && init?.body) {
        articles.push({ id: 'a1', collection: 'Manuals', title: init.body.title, status: 'pending', submittedAt: '2026-09-28T00:00:00Z', documentId: null });
        return { id: 'a1', status: 'pending' };
      }
    });
    await dom.render(<Articles />);
    const form = dom.$<HTMLFormElement>('form');
    await type(form.querySelector('select')!, 'c1');
    await type(form.querySelector('input')!, 'VPN guide');
    await type(form.querySelector('textarea')!, 'Request VPN access from IT.');
    await submit(form);

    expect(api).toHaveBeenCalledWith('/knowledge/articles', {
      body: { collectionId: 'c1', title: 'VPN guide', body: 'Request VPN access from IT.' },
    });
    expect(dom.$('tbody').textContent).toContain('VPN guide');
    expect(dom.$('tbody').textContent).toContain('In review');
    expect(dom.$('[role=status]').textContent).toContain('Article submitted for review');
  });

  it('shows an informative state when embedding is not configured', async () => {
    api.mockImplementation(async (path: string) => path === '/knowledge/collections'
      ? { enabled: false, collections: [] } : []);
    await dom.render(<Articles />);
    expect(dom.$('form')).toBeNull();
    expect(dom.el.textContent).toContain('The knowledge base has not been set up yet.');
  });
});
