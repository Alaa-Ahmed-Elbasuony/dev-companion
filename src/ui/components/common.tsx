import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { statusClass } from '../../analysis/filter';
import type { NetworkEntry } from '../../shared/types';
import { copyText } from '../lib/extension';

export function CopyButton({
  text,
  label,
  disabledReason,
}: {
  text: () => string | null;
  label: string;
  disabledReason?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="btn btn-small"
      disabled={!!disabledReason}
      title={disabledReason ?? `Copy ${label.toLowerCase()}`}
      onClick={async () => {
        const value = text();
        if (value === null) return;
        const ok = await copyText(value);
        setState(ok ? 'copied' : 'failed');
        setTimeout(() => setState('idle'), 1200);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

export function StatusPill({ entry }: { entry: NetworkEntry }) {
  const cls = statusClass(entry);
  // Beacons complete without an observable HTTP status.
  const text =
    entry.state === 'complete' ? (entry.status !== undefined ? String(entry.status) : 'sent') : entry.state;
  return <span className={`pill pill-${cls}`}>{text}</span>;
}

export function MethodTag({ method }: { method: string }) {
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: ReactNode; disabled?: boolean }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={`tab ${t.id === active ? 'tab-active' : ''}`}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ kind, children }: { kind: 'warning' | 'info' | 'error'; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Focus moves into the dialog and returns to the opener when it closes.
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      // Keep Tab / Shift+Tab inside the dialog.
      const focusable = [
        ...ref.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Fixed-row-height virtualized list. */
export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  className,
}: {
  items: T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);
  const overscan = 8;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>
          {items.slice(start, end).map((item, i) => renderRow(item, start + i))}
        </div>
      </div>
    </div>
  );
}

export function KeyValueTable({
  rows,
  empty,
}: {
  rows: { name: string; value: ReactNode }[];
  empty: string;
}) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <table className="kv">
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.name}-${i}`}>
            <th>{r.name}</th>
            <td>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
