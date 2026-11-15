import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

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

function Modal({ options, onClose }: { options: ConfirmOptions; onClose(ok: boolean): void }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
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
    </div>
  );
}
