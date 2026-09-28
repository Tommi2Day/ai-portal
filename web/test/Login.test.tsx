import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
const { Login } = await import('../src/Login');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('de'); api.mockReset(); dom = mount(); });
afterEach(() => dom.unmount());

const fill = async (user: string, pw: string) => {
  const [u, p] = dom.$$<HTMLInputElement>('input');
  await type(u, user);
  await type(p, pw);
};

describe('Login', () => {
  it('offers LDAP and local sign-in, preselects LDAP and sends the chosen method', async () => {
    api.mockResolvedValueOnce({ local: true, ldap: true, oidc: null }).mockResolvedValueOnce({ ok: true });
    const onDone = vi.fn();
    await dom.render(<Login onDone={onDone} />);
    const [ldapBtn, localBtn] = dom.$$<HTMLButtonElement>('.seg button');
    expect(ldapBtn.className).toBe('active');
    expect(dom.$<HTMLButtonElement>('button[type=submit]').disabled).toBe(true);

    await click(localBtn);
    await fill('anna', 'geheim');
    expect(dom.$<HTMLButtonElement>('button[type=submit]').disabled).toBe(false);
    await submit(dom.$('form'));
    expect(api).toHaveBeenLastCalledWith('/auth/login', { body: { username: 'anna', password: 'geheim', method: 'local' } });
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the server error and stays on the page', async () => {
    api.mockResolvedValueOnce({ local: true, ldap: false, oidc: null }).mockRejectedValueOnce(new Error('Benutzername oder Passwort falsch'));
    const onDone = vi.fn();
    await dom.render(<Login onDone={onDone} />);
    expect(dom.el.querySelector('.seg')).toBeNull();
    await fill('anna', 'falsch');
    await submit(dom.$('form'));
    expect(dom.$('.error').textContent).toBe('Benutzername oder Passwort falsch');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('SSO only: no password form, a link to the OIDC flow', async () => {
    api.mockResolvedValueOnce({ local: false, ldap: false, oidc: { name: 'Microsoft' } });
    await dom.render(<Login onDone={vi.fn()} />);
    expect(dom.el.querySelector('input[type=password]')).toBeNull();
    expect(dom.$('a.button').getAttribute('href')).toBe('/api/auth/oidc/start');
    expect(dom.$('a.button').textContent).toBe('Mit Microsoft anmelden');
    expect(dom.el.querySelector('.divider')).toBeNull();
  });
});
