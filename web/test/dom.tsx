/** Minimal DOM helpers for component tests (jsdom + React act, no testing library). */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const root: Root = createRoot(el);
  return {
    el,
    render: (node: ReactNode) => act(async () => { root.render(node); }),
    unmount: () => { act(() => root.unmount()); el.remove(); },
    $: <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel)!,
    $$: <T extends Element = HTMLElement>(sel: string) => [...el.querySelectorAll<T>(sel)],
  };
}

/** Sets an input/select value through the native setter so React's onChange fires. */
export async function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}

export const click = (e: HTMLElement) => act(async () => { e.click(); });

export const submit = (form: HTMLFormElement) => act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
