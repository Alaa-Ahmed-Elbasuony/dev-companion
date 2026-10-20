import { useEffect, useState } from 'react';
import { normalizeSettings } from '../../shared/settings';
import type { Settings } from '../../shared/types';
import { loadSettings } from './extension';

/** Increments whenever the worker or another page reports changed data. */
export function useDataVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (message: { type?: string }) => {
      if (message?.type !== 'data-changed' && message?.type !== 'recording-changed') return;
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), 150);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);
  return version;
}

export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void loadSettings().then(setSettings);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings) setSettings(normalizeSettings(changes.settings.newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return settings;
}
