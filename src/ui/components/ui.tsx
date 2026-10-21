// Shared presentation components for the dashboard. Status is never conveyed
// by color alone: every badge carries a symbol and a text label.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EvidenceLevel } from '../../analysis/error-detector';
import type { LinkStrength } from '../../analysis/trace-correlate';
import { valueForCopy } from '../lib/copy-format';
import { CodeBlock, CopyButton, CopyIcon, Modal } from './common';

export type Tone = 'error' | 'warning' | 'ok' | 'info' | 'muted';
const TONE_ICON: Record<Tone, string> = { error: '✕', warning: '!', ok: '✓', info: '•', muted: '·' };

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span aria-hidden="true" className="badge-icon">
        {TONE_ICON[tone]}
      </span>
      {children}
    </span>
  );
}

const LEVEL: Record<EvidenceLevel, { tone: Tone; label: string; help: string }> = {
  confirmed: { tone: 'ok', label: 'Confirmed', help: 'Directly observed in the recorded data.' },
  strong: {
    tone: 'info',
    label: 'Strong hypothesis',
    help: 'Supported by specific evidence, not directly proven.',
  },
  possible: {
    tone: 'warning',
    label: 'Possible',
    help: 'Consistent with the evidence; other explanations are equally plausible.',
  },
  insufficient: { tone: 'muted', label: 'Insufficient evidence', help: 'The recorded data cannot tell.' },
};

export function LevelBadge({ level }: { level: EvidenceLevel }) {
  const l = LEVEL[level];
  return (
    <span className={`level level-${level}`} title={l.help}>
      {l.label}
    </span>
  );
}

const RELATION: Record<string, { label: string; help: string }> = {
  anchor: { label: 'selected', help: 'The event under investigation.' },
  explicit: { label: 'shared id', help: 'Both sides carry the same identifier (trace id, request id).' },
  'same-trace': { label: 'same trace', help: 'Part of the same server trace.' },
  'same-connection': { label: 'same connection', help: 'Same realtime connection.' },
  probable: {
    label: 'by time only',
    help: 'Linked by timing (and path), not by a shared identifier. May be coincidental.',
  },
  ambiguous: { label: 'ambiguous', help: 'Several candidates match equally well; not linked.' },
};

export function RelationBadge({ relation }: { relation: string | LinkStrength }) {
  const r = RELATION[relation] ?? { label: relation, help: '' };
  return (
    <span className={`relation relation-${relation}`} title={r.help}>
      {relation === 'explicit' || relation === 'same-trace' ? '⛓ ' : relation === 'probable' ? '≈ ' : ''}
      {r.label}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{title}</p>
      {children && <div className="muted small">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export interface Chip {
  id: string;
  label: string;
  onRemove: () => void;
}

export function ActiveFilters({
  chips,
  onClearAll,
  shown,
  total,
  noun = 'items',
}: {
  chips: Chip[];
  onClearAll: () => void;
  shown: number;
  total: number;
  noun?: string;
}) {
  return (
    <div className="active-filters" aria-live="polite">
      <span className="count">
        <strong>{shown}</strong> of {total} {noun}
      </span>
      {chips.map((c) => (
        <span key={c.id} className="filter-chip">
          {c.label}
          <button type="button" aria-label={`Remove filter ${c.label}`} onClick={c.onRemove}>
            ×
          </button>
        </span>
      ))}
      {chips.length > 0 && (
        <button type="button" className="link small" onClick={onClearAll}>
          Clear all filters
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm-body">{children}</div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function MetricTile({
  label,
  value,
  tone = 'muted',
  hint,
  unavailable,
  onClick,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  /** Shown instead of a number when the data source is not configured or not captured. */
  unavailable?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="metric-label">{label}</span>
      {unavailable ? (
        <span className="metric-unavailable">{unavailable}</span>
      ) : (
        <span className={`metric-value tone-${tone}`}>{value}</span>
      )}
      {hint && <span className="metric-hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`metric metric-${tone}`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={`metric metric-${tone}`}>{content}</div>
  );
}

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => !c.disabled && (!q || c.label.toLowerCase().includes(q)));
  }, [commands, query]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="palette-list"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(list.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(list[index]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul id="palette-list" role="listbox" className="palette-list">
          {list.length === 0 && <li className="muted pad-s">No matching command</li>}
          {list.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'palette-active' : ''}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(c);
              }}
            >
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ShortcutHelp({
  items,
  onClose,
}: {
  items: { keys: string; description: string }[];
  onClose: () => void;
}) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="kv shortcuts">
        <tbody>
          {items.map((s) => (
            <tr key={s.keys}>
              <th>
                <kbd>{s.keys}</kbd>
              </th>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Single-key shortcuts are ignored while typing in a field.</p>
    </Modal>
  );
}

// ---- JSON tree -------------------------------------------------------------------

const MAX_CHILDREN = 200;

function JsonNode({
  name,
  value,
  depth,
  defaultOpen,
}: {
  name?: string;
  value: unknown;
  depth: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const label = name !== undefined ? <span className="tok-key">{JSON.stringify(name)}</span> : null;
  if (value === null || typeof value !== 'object') {
    const cls =
      typeof value === 'string' ? 'tok-string' : typeof value === 'number' ? 'tok-number' : 'tok-literal';
    const text =
      typeof value === 'string'
        ? JSON.stringify(value.length > 2000 && !showAll ? `${value.slice(0, 2000)}` : value)
        : String(value);
    return (
      <div className="jt-row">
        {label}
        {label && ': '}
        <span className={cls}>{text}</span>
        {typeof value === 'string' && value.length > 2000 && !showAll && (
          <button type="button" className="link small" onClick={() => setShowAll(true)}>
            … {value.length - 2000} more characters
          </button>
        )}
        <CopyIcon label={`Copy ${name ?? 'value'}`} text={() => valueForCopy(value)} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as object);
  const brackets = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (!entries.length) {
    return (
      <div className="jt-row">
        {label}
        {label && ': '}
        <span className="muted">{brackets.join('')}</span>
      </div>
    );
  }
  const visible = showAll ? entries : entries.slice(0, MAX_CHILDREN);
  return (
    <div className="jt-node">
      <div className="jt-toggle-row">
        <button type="button" className="jt-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
          {label && ': '}
          {brackets[0]}
          {!open && (
            <span className="muted">
              {' '}
              {entries.length} {Array.isArray(value) ? 'items' : 'keys'} {brackets[1]}
            </span>
          )}
        </button>
        <CopyIcon label={`Copy ${name ?? 'value'}`} text={() => valueForCopy(value)} />
      </div>
      {open && (
        <div className="jt-children">
          {visible.map(([k, v]) => (
            <JsonNode
              key={k}
              name={Array.isArray(value) ? undefined : k}
              value={v}
              depth={depth + 1}
              defaultOpen={depth < 1}
            />
          ))}
          {entries.length > visible.length && (
            <button type="button" className="link small" onClick={() => setShowAll(true)}>
              Show {entries.length - visible.length} more
            </button>
          )}
          <div className="jt-row">{brackets[1]}</div>
        </div>
      )}
    </div>
  );
}

/** Collapsible JSON view. Parsing of large documents happens in a worker. */
export function JsonTree({ text, value }: { text?: string; value?: unknown }) {
  const [state, setState] = useState<{ status: 'parsing' | 'ok' | 'error'; value?: unknown; error?: string }>(
    value !== undefined ? { status: 'ok', value } : { status: 'parsing' },
  );
  useEffect(() => {
    if (value !== undefined) {
      setState({ status: 'ok', value });
      return;
    }
    if (text === undefined) return;
    let cancelled = false;
    if (text.length < 256 * 1024) {
      try {
        setState({ status: 'ok', value: JSON.parse(text) });
      } catch (err) {
        setState({ status: 'error', error: String(err) });
      }
      return;
    }
    setState({ status: 'parsing' });
    const worker = new Worker(new URL('../lib/json-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ ok: boolean; value?: unknown; error?: string }>) => {
      if (!cancelled)
        setState(
          e.data.ok ? { status: 'ok', value: e.data.value } : { status: 'error', error: e.data.error },
        );
      worker.terminate();
    };
    worker.onerror = () => {
      if (!cancelled) setState({ status: 'error', error: 'Parser worker failed' });
      worker.terminate();
    };
    worker.postMessage(text);
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [text, value]);
  if (state.status === 'parsing') return <p className="muted small">Parsing large JSON…</p>;
  if (state.status === 'error') {
    return (
      <div>
        <p className="muted small">Not valid JSON ({state.error}); showing raw text instead.</p>
        {text !== undefined && <CodeBlock text={text} />}
      </div>
    );
  }
  return (
    <div className="json-tree-wrap">
      <div className="code-toolbar">
        <CopyButton label="Copy JSON" text={() => valueForCopy(state.value)} />
      </div>
      <div className="json-tree mono">
        <JsonNode value={state.value} depth={0} defaultOpen />
      </div>
    </div>
  );
}
