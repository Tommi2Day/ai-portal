import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
const { Profile } = await import('../src/Profile');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('en'); api.mockReset(); dom = mount(); });
afterEach(() => dom.unmount());

describe('Profile', () => {
  it('prefills name and email from the directory and saves the confirmed values', async () => {
    const me = { id: 'u1', username: 'max', displayName: 'Max Mustermann', email: 'max@corp.example', role: 'user' as const, authSource: 'ldap', profileCompleted: false };
    const saved = { ...me, displayName: 'Maximilian Mustermann', profileCompleted: true };
    api.mockResolvedValueOnce(saved);
    const onDone = vi.fn();
    await dom.render(<Profile me={me} onDone={onDone} onLogout={vi.fn()} />);
    const [name, email] = dom.$$<HTMLInputElement>('input');
    expect(name.value).toBe('Max Mustermann');
    expect(email.value).toBe('max@corp.example');
    await type(name, 'Maximilian Mustermann');
    await submit(dom.$('form'));
    expect(api).toHaveBeenCalledWith('/auth/profile', { method: 'PUT', body: { displayName: 'Maximilian Mustermann', email: 'max@corp.example' } });
    expect(onDone).toHaveBeenCalledWith(saved);
  });
});
