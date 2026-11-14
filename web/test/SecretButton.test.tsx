import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, submit, type } from './dom';

const { SecretButton } = await import('../src/SecretButton');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('de'); dom = mount(); });
afterEach(() => dom.unmount());

describe('SecretButton', () => {
  it('asks for the secret in a masked field (not window.prompt), submits it and forgets it', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const onSubmit = vi.fn();
    await dom.render(<SecretButton label="Schlüssel" placeholder="Neuer API-Schlüssel" onSubmit={onSubmit} />);
    await click(dom.$<HTMLButtonElement>('button')!);
    const input = dom.$<HTMLInputElement>('input')!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');
    await type(input, 'sk-live-123');
    await submit(dom.$<HTMLFormElement>('form')!);
    expect(onSubmit).toHaveBeenCalledWith('sk-live-123');
    expect(prompt).not.toHaveBeenCalled();
    // back to the button; nothing of the secret stays in the DOM
    expect(dom.$('input')).toBeNull();
    expect(dom.$('button')!.textContent).toBe('Schlüssel');
    expect(document.body.innerHTML).not.toContain('sk-live-123');
    vi.unstubAllGlobals();
  });

  it('enforces the minimum length and can be cancelled', async () => {
    const onSubmit = vi.fn();
    await dom.render(<SecretButton label="Passwort" placeholder="Neues Passwort" minLength={12} onSubmit={onSubmit} />);
    await click(dom.$<HTMLButtonElement>('button')!);
    await type(dom.$<HTMLInputElement>('input')!, 'short');
    expect(dom.$<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
    await click(dom.$$<HTMLButtonElement>('button').find((b) => b.textContent === 'Abbrechen')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dom.$('input')).toBeNull();
  });
});
