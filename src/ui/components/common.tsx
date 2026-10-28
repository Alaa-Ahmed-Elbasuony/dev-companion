import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { statusClass } from '../../analysis/filter';
import type { NetworkEntry } from '../../shared/types';
import { prettyForCopy } from '../lib/copy-format';
import { copyText } from '../lib/extension';

type CopyState = 'idle' | 'copied' | 'failed';

/** Shared click handler: resolves the text, formats it unless `raw`, and flashes the result. */
type CopySource = () => string | null | Promise<string | null>;

function useCopy(text: CopySource, raw: boolean) {
  const [state, setState] = useState<CopyState>('idle');
  const copy = async () => {
    let ok: boolean;
    try {
      const value = await text();
      if (value === null) return;
      ok = await copyText(raw ? value : prettyForCopy(value));
    } catch {
      ok = false;
    }
    setState(ok ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1200);
  };
  return [state, copy] as const;
}

/** Labelled copy button. JSON text is pretty-printed on the clipboard unless `raw` is set. */
export function CopyButton({
  text,
  label,
  disabledReason,
  raw = false,
}: {
  text: CopySource;
  label: string;
  disabledReason?: string;
  raw?: boolean;
}) {
  const [state, copy] = useCopy(text, raw);
  return (
    <button
      type="button"
      className="btn btn-small"
      disabled={!!disabledReason}
      title={disabledReason ?? `${label} to the clipboard`}
      onClick={copy}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

/** Compact icon-only copy button for inline values (ids, header values, JSON nodes). */
export function CopyIcon({ text, label, raw = false }: { text: CopySource; label: string; raw?: boolean }) {
  const [state, copy] = useCopy(text, raw);
  return (
    <button
      type="button"
      className={`copy-icon copy-${state}`}
      title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
    >
      {state === 'copied' ? '✓' : state === 'failed' ? '!' : '⧉'}
    </button>
  );
}

/** Preformatted block (stack traces, raw payloads) with a copy button in the corner. */
export function CodeBlock({
  text,
  label = 'Copy',
  raw = false,
}: {
  text: string;
  label?: string;
  raw?: boolean;
}) {
  return (
    <div className="code-wrap">
      <div className="code-toolbar">
        <CopyIcon label={label} text={() => text} raw={raw} />
      </div>
      <pre className="code">{text}</pre>
    </div>
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
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
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
      <div className={className ? `modal ${className}` : 'modal'} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
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

/**
 * Name/value table. With `copyable`, each row gets a copy icon: it copies `row.copy`,
 * or the value itself when it is a string. Rows with neither get no icon.
 */
export function KeyValueTable({
  rows,
  empty,
  copyable = false,
}: {
  rows: { name: string; value: ReactNode; copy?: string }[];
  empty: string;
  copyable?: boolean;
}) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <table className="kv">
      <tbody>
        {rows.map((r, i) => {
          const copy = r.copy ?? (typeof r.value === 'string' ? r.value : undefined);
          return (
            <tr key={`${r.name}-${i}`} className={copyable ? 'kv-copyable' : undefined}>
              <th>{r.name}</th>
              <td>
                {r.value}
                {copyable && copy !== undefined && <CopyIcon label={`Copy ${r.name}`} text={() => copy} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
