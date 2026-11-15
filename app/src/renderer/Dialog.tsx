import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

/**
 * A modal question with two buttons. `ask` resolves to true when the person
 * confirms; Escape and the backdrop cancel.
 */
export function useConfirm(): [ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [open, setOpen] = useState<(ConfirmOptions & { resolve(ok: boolean): void }) | undefined>();
  const ask = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setOpen({ ...options, resolve })), []);
  const close = (ok: boolean): void => {
    open?.resolve(ok);
    setOpen(undefined);
  };
  const element = open ? <Modal options={open} onClose={close} /> : null;
  return [element, ask];
}

/** Dialogs open right now; the app stays inert while any is. */
let openDialogs = 0;

/** Events that change something in a form or press a button. */
const SHIELDED = ['input', 'beforeinput', 'change', 'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'submit', 'paste', 'cut', 'drop'];

/**
 * The app (#root) is made inert while a dialog is open, and the dialog is
 * rendered outside it. Inert content takes no focus, no clicks and no keys,
 * so nothing typed while the dialog is up can land in a form behind it.
 *
 * Inert does not stop events dispatched from code (element.click(), a
 * synthetic "input"), which is how a script once saved one CLI's models
 * into another. A capture listener on window runs before React's listeners
 * on #root and stops any such event aimed at the app.
 */
function blockApp(): () => void {
  const root = document.getElementById('root');
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const shield = (event: Event): void => {
    if (root && event.target instanceof Node && root.contains(event.target)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  };
  openDialogs += 1;
  if (root) root.inert = true;
  for (const type of SHIELDED) window.addEventListener(type, shield, true);
  return () => {
    for (const type of SHIELDED) window.removeEventListener(type, shield, true);
    openDialogs -= 1;
    if (openDialogs === 0 && root) {
      root.inert = false;
      before?.focus();
    }
  };
}

function Modal({ options, onClose }: { options: ConfirmOptions; onClose(ok: boolean): void }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const unblock = blockApp();
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unblock();
    };
  }, []);
  return createPortal(
    // Closing on click, not mousedown: the press must not reach, or focus, whatever is under the backdrop.
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()} onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{options.title}</h2>
        <div className="modal-body">{options.body}</div>
        <div className="row end">
          <button ref={cancelRef} className="button" onClick={() => onClose(false)}>
            {options.cancel ?? 'Отмена'}
          </button>
          <button className={`button ${options.danger ? 'danger' : 'primary'}`} onClick={() => onClose(true)}>
            {options.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
