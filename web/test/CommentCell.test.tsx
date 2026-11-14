import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type } from './dom';

const { CommentCell } = await import('../src/CommentCell');
const { setLang } = await import('../src/i18n');

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('de'); dom = mount(); });
afterEach(() => dom.unmount());

const press = (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
const leave = (el: Element) => act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

const input = () => dom.$<HTMLInputElement>('input');
const cell = () => dom.$<HTMLButtonElement>('button.comment');

describe('CommentCell', () => {
  it('shows the note, or a "+ note" hint when there is none, and opens an input on click', async () => {
    await dom.render(<CommentCell value="Ticket OPS-123" onSave={vi.fn()} />);
    expect(cell().textContent).toBe('Ticket OPS-123');
    await click(cell());
    expect(input().value).toBe('Ticket OPS-123');
    expect(input().maxLength).toBe(300);
    expect(input().placeholder).toBe('Kommentar');
    expect(dom.$('button.comment')).toBeNull();
  });

  it('empty and missing values show the hint', async () => {
    await dom.render(<CommentCell value={null} onSave={vi.fn()} />);
    expect(cell().textContent).toBe('+ Notiz');
    await dom.render(<CommentCell value="" onSave={vi.fn()} />);
    expect(cell().textContent).toBe('+ Notiz');
  });

  it('Enter saves the trimmed text once, even if the field is left afterwards', async () => {
    const onSave = vi.fn();
    await dom.render(<CommentCell value={null} onSave={onSave} />);
    await click(cell());
    await type(input(), '  Bereitschaft Team A  ');
    const el = input();
    await press(el, 'Enter');
    await leave(el);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Bereitschaft Team A');
    expect(dom.$('input')).toBeNull();
  });

  it('leaving the field saves, Escape cancels, an unchanged text is not saved', async () => {
    const onSave = vi.fn();
    await dom.render(<CommentCell value="alt" onSave={onSave} />);
    await click(cell());
    await type(input(), 'neu');
    await leave(input());
    expect(onSave).toHaveBeenLastCalledWith('neu');

    onSave.mockClear();
    await click(cell());
    await type(input(), 'verworfen');
    await press(input(), 'Escape');
    expect(onSave).not.toHaveBeenCalled();
    expect(dom.$('input')).toBeNull();

    await click(cell());
    await press(input(), 'Enter'); // nothing changed
    expect(onSave).not.toHaveBeenCalled();
  });

  it('an emptied field removes the note (saves an empty text); the length limit can be set', async () => {
    const onSave = vi.fn();
    await dom.render(<CommentCell value="Notiz" max={200} onSave={onSave} />);
    await click(cell());
    expect(input().maxLength).toBe(200);
    await type(input(), '   ');
    await press(input(), 'Enter');
    expect(onSave).toHaveBeenCalledWith('');
  });
});
