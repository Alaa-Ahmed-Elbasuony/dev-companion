// Live view of the inspected site's cookies, local/session storage, IndexedDB,
// Cache Storage and service workers, read from the tab on demand.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatBytes, tryParseJson, utf8Length } from '../../shared/util';
import { CodeBlock, CopyIcon, Notice, Tabs } from '../components/common';
import { EmptyState, JsonTree } from '../components/ui';
import {
  SITE_DATA_KINDS,
  clearSiteData,
  hasSiteDataAccess,
  readSiteData,
  removeCookie,
  removeSiteItem,
  requestSiteDataAccess,
} from '../lib/site-data';
import type { SiteDataKind, SiteItemKind, SiteSnapshot } from '../lib/site-data';
import type { ViewProps } from './context';

export interface SiteTarget {
  tabId?: number;
  url?: string;
  host: string;
  /** Why the site cannot be read, or null when it can. */
  blocked: string | null;
  /** Bumped when site data was cleared elsewhere (the header). */
  version: number;
}

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);

function ValueDetails({ value }: { value: string }) {
  const parsed = tryParseJson(value);
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? (
    <JsonTree value={parsed.value} />
  ) : (
    <CodeBlock text={value} label="Copy value" raw />
  );
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      ✕
    </button>
  );
}

export function StorageView(props: ViewProps & { site: SiteTarget }) {
  const { site, params, setParams } = props;
  const section = (
    SITE_DATA_KINDS.some((k) => k.kind === params.section) ? params.section : 'cookies'
  ) as SiteDataKind;
  const query = params.q ?? '';
  const [access, setAccess] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<SiteSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'warning' | 'error'; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (site.blocked || site.tabId === undefined || !site.url) return;
    const granted = await hasSiteDataAccess(site.url);
    setAccess(granted);
    if (!granted) return;
    setLoading(true);
    try {
      setSnapshot(await readSiteData(site.tabId, site.url));
      setReadAt(Date.now());
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setLoading(false);
    }
  }, [site.blocked, site.tabId, site.url]);

  useEffect(() => {
    void refresh();
  }, [refresh, site.version]);

  const setSection = (s: SiteDataKind) => {
    setExpanded(null);
    setParams({ ...params, section: s });
  };

  const grant = () => {
    if (!site.url) return;
    requestSiteDataAccess(site.url)
      .then((granted) => {
        if (!granted) setMessage({ kind: 'warning', text: 'Access was not granted.' });
        return refresh();
      })
      .catch((err: unknown) => setMessage({ kind: 'error', text: errorText(err) }));
  };

  const afterChange = (ok: boolean, what: string) => {
    setMessage(
      ok ? { kind: 'info', text: `Removed ${what}.` } : { kind: 'error', text: `Could not remove ${what}.` },
    );
    void refresh();
  };
  const removeItem = (kind: SiteItemKind, key: string, what: string) => {
    if (site.tabId === undefined) return;
    removeSiteItem(site.tabId, kind, key).then(
      (ok) => afterChange(ok, what),
      (err: unknown) => setMessage({ kind: 'error', text: errorText(err) }),
    );
  };
  const clearSection = () => {
    if (site.tabId === undefined || !site.url) return;
    clearSiteData(site.tabId, site.url, [section])
      .then((result) => {
        setMessage({ kind: result.ok ? 'info' : 'warning', text: result.message });
        return refresh();
      })
      .catch((err: unknown) => setMessage({ kind: 'error', text: errorText(err) }));
  };

  const q = query.toLowerCase();
  const match = (...parts: (string | undefined)[]) => !q || parts.some((p) => p?.toLowerCase().includes(q));
  const counts: Record<SiteDataKind, number> = useMemo(
    () => ({
      cookies: snapshot?.cookies.length ?? 0,
      localStorage: snapshot?.localStorage.length ?? 0,
      sessionStorage: snapshot?.sessionStorage.length ?? 0,
      indexedDB: snapshot?.indexedDB.length ?? 0,
      cacheStorage: snapshot?.cacheStorage.length ?? 0,
      serviceWorkers: snapshot?.serviceWorkers.length ?? 0,
    }),
    [snapshot],
  );

  if (site.blocked) {
    return (
      <div className="storage-view">
        <EmptyState title="No site to read">{site.blocked}</EmptyState>
      </div>
    );
  }
  if (access === false) {
    return (
      <div className="storage-view">
        <EmptyState
          title={`Allow access to ${site.host}`}
          action={
            <button type="button" className="btn btn-primary" onClick={grant}>
              Allow access
            </button>
          }
        >
          Reading cookies and storage needs the optional “cookies” permission and access to this site.
        </EmptyState>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </div>
    );
  }

  const label = SITE_DATA_KINDS.find((k) => k.kind === section)!.label;
  const toggle = (key: string) => setExpanded((e) => (e === key ? null : key));

  let body: ReactNode;
  if (!snapshot) body = <p className="muted pad">{loading ? 'Reading…' : 'Nothing read yet.'}</p>;
  else if (section === 'cookies') {
    const rows = snapshot.cookies.filter((c) => match(c.name, c.value, c.domain));
    body = rows.length ? (
      <table className="storage-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Domain</th>
            <th>Path</th>
            <th>Expires</th>
            <th>Size</th>
            <th>Flags</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const key = `${c.storeId}|${c.domain}|${c.path}|${c.name}`;
            return (
              <Fragment key={key}>
                <tr className="storage-row" onClick={() => toggle(key)} aria-expanded={expanded === key}>
                  <td className="mono">
                    {c.name}
                    <CopyIcon label="Copy name" text={() => c.name} raw />
                  </td>
                  <td className="mono storage-value" title={c.value}>
                    {c.value}
                    <CopyIcon label="Copy value" text={() => c.value} raw />
                  </td>
                  <td className="mono">{c.domain}</td>
                  <td className="mono">{c.path}</td>
                  <td className="small">
                    {c.session || !c.expirationDate
                      ? 'Session'
                      : new Date(c.expirationDate * 1000).toLocaleString()}
                  </td>
                  <td className="small">{formatBytes(utf8Length(c.name + c.value))}</td>
                  <td className="small">
                    {[
                      c.httpOnly && 'HttpOnly',
                      c.secure && 'Secure',
                      c.sameSite !== 'unspecified' && c.sameSite,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td>
                    <DeleteButton
                      label={`Delete cookie ${c.name}`}
                      onClick={() => void removeCookie(c).then((ok) => afterChange(ok, `cookie “${c.name}”`))}
                    />
                  </td>
                </tr>
                {expanded === key && (
                  <tr className="storage-details">
                    <td colSpan={8}>
                      <ValueDetails value={c.value} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    ) : null;
  } else if (section === 'localStorage' || section === 'sessionStorage') {
    const rows = snapshot[section].filter(([k, v]) => match(k, v));
    body = rows.length ? (
      <table className="storage-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Size</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <tr className="storage-row" onClick={() => toggle(k)} aria-expanded={expanded === k}>
                <td className="mono">
                  {k}
                  <CopyIcon label="Copy key" text={() => k} raw />
                </td>
                <td className="mono storage-value" title={v.length > 2000 ? undefined : v}>
                  {v.slice(0, 300)}
                  <CopyIcon label="Copy value" text={() => v} />
                </td>
                <td className="small">{formatBytes(utf8Length(k + v))}</td>
                <td>
                  <DeleteButton label={`Delete ${k}`} onClick={() => removeItem(section, k, `“${k}”`)} />
                </td>
              </tr>
              {expanded === k && (
                <tr className="storage-details">
                  <td colSpan={4}>
                    <ValueDetails value={v} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    ) : null;
  } else if (section === 'indexedDB') {
    const rows = snapshot.indexedDB.filter((d) => match(d.name, ...d.stores.map((s) => s.name)));
    body = rows.length ? (
      <table className="storage-table">
        <thead>
          <tr>
            <th>Database</th>
            <th>Version</th>
            <th>Object stores (records)</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.name}>
              <td className="mono">{d.name}</td>
              <td className="small">{d.version ?? '—'}</td>
              <td className="small">
                {d.error ? (
                  <span className="text-error">{d.error}</span>
                ) : d.stores.length ? (
                  d.stores.map((s) => `${s.name} (${s.count})`).join(', ')
                ) : (
                  <span className="muted">No object stores</span>
                )}
              </td>
              <td>
                <DeleteButton
                  label={`Delete database ${d.name}`}
                  onClick={() => removeItem('indexedDB', d.name, `database “${d.name}”`)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null;
  } else if (section === 'cacheStorage') {
    const rows = snapshot.cacheStorage.filter((c) => match(c.name, ...c.urls));
    body = rows.length ? (
      <table className="storage-table">
        <thead>
          <tr>
            <th>Cache</th>
            <th>Entries</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <Fragment key={c.name}>
              <tr className="storage-row" onClick={() => toggle(c.name)} aria-expanded={expanded === c.name}>
                <td className="mono">{c.name}</td>
                <td className="small">{c.total}</td>
                <td>
                  <DeleteButton
                    label={`Delete cache ${c.name}`}
                    onClick={() => removeItem('cacheStorage', c.name, `cache “${c.name}”`)}
                  />
                </td>
              </tr>
              {expanded === c.name && (
                <tr className="storage-details">
                  <td colSpan={3}>
                    <CodeBlock
                      text={
                        c.urls.join('\n') +
                        (c.total > c.urls.length ? `\n… ${c.total - c.urls.length} more` : '')
                      }
                      label="Copy URLs"
                      raw
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    ) : null;
  } else {
    const rows = snapshot.serviceWorkers.filter((w) => match(w.scope, w.scriptURL));
    body = rows.length ? (
      <table className="storage-table">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Script</th>
            <th>State</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.scope}>
              <td className="mono">{w.scope}</td>
              <td className="mono storage-value">{w.scriptURL}</td>
              <td className="small">{w.state}</td>
              <td>
                <DeleteButton
                  label={`Unregister ${w.scope}`}
                  onClick={() => removeItem('serviceWorkers', w.scope, `service worker “${w.scope}”`)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null;
  }

  return (
    <div className="storage-view">
      <div className="filters">
        <input
          type="search"
          className="search"
          placeholder={`Search ${label.toLowerCase()}`}
          aria-label="Search storage"
          value={query}
          onChange={(e) => setParams({ ...params, q: e.target.value })}
        />
        <button type="button" className="btn btn-small" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="muted small">
          {site.host}
          {readAt ? ` · read at ${new Date(readAt).toLocaleTimeString()}` : ''}
        </span>
      </div>
      <Tabs<SiteDataKind>
        active={section}
        onChange={setSection}
        tabs={SITE_DATA_KINDS.map((k) => ({ id: k.kind, label: `${k.label} (${counts[k.kind]})` }))}
      />
      {snapshot?.pageError && section !== 'cookies' && (
        <Notice kind="warning">
          The page's storage could not be read: {snapshot.pageError}. Reload the page and try again.
        </Notice>
      )}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="toolbar">
        <span className="muted small">
          {section === 'cookies'
            ? 'Cookies sent to this site, including HttpOnly and parent-domain cookies. Click a row to see the full value.'
            : section === 'indexedDB'
              ? 'Databases with their object stores and record counts.'
              : section === 'cacheStorage'
                ? 'Click a cache to list its URLs.'
                : section === 'serviceWorkers'
                  ? 'Registered service workers for this origin.'
                  : 'Click a row to see the full value (JSON is shown as a tree).'}
        </span>
        <button
          type="button"
          className="btn btn-small btn-danger storage-clear"
          disabled={!counts[section]}
          onClick={clearSection}
        >
          Clear {label.toLowerCase()}
        </button>
      </div>
      <div className="storage-body">
        {body ?? (
          <EmptyState title={query ? 'No matches' : `No ${label.toLowerCase()}`}>
            {query ? 'Try a different search.' : `${site.host} has nothing stored here.`}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
