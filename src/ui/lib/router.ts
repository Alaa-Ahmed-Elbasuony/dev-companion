// View state in the URL hash (#network?status=failed&id=...), so a view and its
// filters survive reloads and can be linked from the popup or the Overview.
import { useCallback, useEffect, useState } from 'react';

export type View =
  | 'overview'
  | 'network'
  | 'realtime'
  | 'timeline'
  | 'tracing'
  | 'console'
  | 'storage'
  | 'investigations'
  | 'settings';

export const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'network', label: 'Network', key: '2' },
  { id: 'realtime', label: 'Realtime', key: '3' },
  { id: 'timeline', label: 'Timeline', key: '4' },
  { id: 'tracing', label: 'Tracing', key: '5' },
  { id: 'console', label: 'Console', key: '6' },
  { id: 'storage', label: 'Storage', key: '7' },
  { id: 'investigations', label: 'Investigations', key: '8' },
  { id: 'settings', label: 'Settings', key: '9' },
];

export interface Route {
  view: View;
  params: Record<string, string>;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const view = (VIEWS.find((v) => v.id === path)?.id ?? 'overview') as View;
  return { view, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function formatHash(route: Route): string {
  const query = new URLSearchParams(
    Object.entries(route.params).filter(([, v]) => v !== '' && v !== undefined),
  ).toString();
  return `#${route.view}${query ? `?${query}` : ''}`;
}

export function useRoute(initialView: View = 'overview') {
  const [route, setRoute] = useState<Route>(() =>
    location.hash ? parseHash(location.hash) : { view: initialView, params: {} },
  );
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((view: View, params: Record<string, string> = {}, replace = false) => {
    const next = formatHash({ view, params });
    if (replace) history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
    else history.pushState(null, '', `${location.pathname}${location.search}${next}`);
    setRoute({ view, params });
  }, []);
  /** Updates params of the current view without adding a history entry (filters). */
  const setParams = useCallback((params: Record<string, string>) => {
    setRoute((r) => {
      const next = { view: r.view, params };
      history.replaceState(null, '', `${location.pathname}${location.search}${formatHash(next)}`);
      return next;
    });
  }, []);
  return { route, navigate, setParams };
}
