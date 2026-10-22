// Keyboard shortcuts. Single-key shortcuts are ignored while typing in a field.
// None of them override Chrome's reserved shortcuts (Ctrl+T/W/N/Tab, etc.);
// Ctrl+K is page-overridable and conventionally opens a command palette.
import { useEffect, useRef } from 'react';

export interface Shortcut {
  /** e.g. "/", "?", "Escape", "j", "ctrl+k", "alt+1" */
  keys: string;
  description: string;
  /** Also fire while focus is in an input/textarea/select. */
  global?: boolean;
  handler: (event: KeyboardEvent) => void;
}

export const SHORTCUT_HELP: { keys: string; description: string }[] = [
  { keys: '/', description: 'Focus search' },
  { keys: 'Ctrl+K', description: 'Command palette' },
  { keys: 'j / k', description: 'Next / previous row' },
  { keys: 'Enter', description: 'Open the selected row' },
  { keys: 'Esc', description: 'Close details, dialogs and the palette' },
  { keys: 'Alt+1 … Alt+9', description: 'Switch view' },
  { keys: 'i', description: 'Investigate the selected event' },
  { keys: '?', description: 'Show shortcuts' },
];

function matches(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split('+');
  const key = parts.pop()!;
  const want = { ctrl: parts.includes('ctrl'), alt: parts.includes('alt'), shift: parts.includes('shift') };
  const ctrl = event.ctrlKey || event.metaKey;
  if (want.ctrl !== ctrl || want.alt !== event.altKey) return false;
  if (want.shift && !event.shiftKey) return false;
  const k = event.key.toLowerCase();
  return k === key || (key === 'escape' && k === 'esc') || (event.altKey && event.code === `Digit${key}`);
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

export function useShortcuts(shortcuts: Shortcut[]) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      for (const s of ref.current) {
        if (!matches(event, s.keys)) continue;
        if (!s.global && isTyping(event.target)) continue;
        event.preventDefault();
        s.handler(event);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
