import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Session } from '../../shared/types';

/**
 * Session dropdown. A native <select> cannot hold buttons, so this is a small
 * listbox that lets each active session be closed with an × button.
 */
export function SessionPicker({
  value,
  sessions,
  onChange,
  onClose,
}: {
  value: string;
  sessions: Session[];
  onChange: (id: string) => void;
  onClose: (session: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const options: { id: string; label: string; session?: Session }[] = [
    { id: 'all', label: 'All sessions' },
    ...sessions.map((s) => ({ id: s.id, label: `${s.label}${s.endedAt ? '' : ' (active)'}`, session: s })),
  ];
  const current = options.find((o) => o.id === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.indexOf(current)));
    setOpen(true);
  };
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const target = options[active];
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(options.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' || e.key === ' ') {
      if (target) choose(target.id);
    } else if (e.key === 'Delete' && target?.session && !target.session.endedAt) onClose(target.session);
    else return;
    e.preventDefault();
  };

  return (
    <div className="session-picker" ref={root}>
      <span className="muted small">Session</span>
      <button
        type="button"
        className="session-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Session"
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        title={current.label}
      >
        <span className="session-picker-label">{current.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="session-picker-list" role="listbox" aria-label="Sessions">
          {options.map((o, i) => (
            <li
              key={o.id}
              role="option"
              aria-selected={o.id === current.id}
              className={`session-picker-option ${i === active ? 'is-active' : ''} ${
                o.id === current.id ? 'is-selected' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.id)}
            >
              <span className="session-picker-label">{o.label}</span>
              {o.session && !o.session.endedAt && (
                <button
                  type="button"
                  className="session-picker-close"
                  title="Close this session (stops recording if it is live; stored data is kept)"
                  aria-label={`Close session ${o.label}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(o.session!);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
