// @vitest-environment jsdom
// Theme switching, the command palette's keyboard model and shared components
// that must not rely on color alone.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveFilters, Badge, CommandPalette } from '../../src/ui/components/ui';
import { readTheme, useTheme } from '../../src/ui/lib/theme';
import { installDomStubs } from '../helpers/dom';

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('theme', () => {
  it('follows the system by default and applies and persists an explicit choice', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    act(() => result.current[1]('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('dc-theme')).toBe('dark');
    act(() => result.current[1]('system'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('dc-theme')).toBeNull();
  });

  it('ignores invalid stored values and survives unavailable storage', () => {
    localStorage.setItem('dc-theme', 'neon');
    expect(readTheme()).toBe('system');
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { result } = renderHook(() => useTheme());
      expect(result.current[0]).toBe('system');
      act(() => result.current[1]('light'));
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('defines the same dark tokens for the explicit choice and the system preference', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/ui/styles.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
      return Object.fromEntries(
        [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]),
      );
    };
    const light = block(':root {');
    const explicit = block(":root[data-theme='dark']");
    const system = block(":root:not([data-theme='light'])");
    expect(system).toEqual(explicit);
    const colorTokens = Object.keys(light).filter((k) => k !== '--shadow-1' && /^#|^rgb/.test(light[k]!));
    for (const k of colorTokens) expect(explicit, `dark theme is missing ${k}`).toHaveProperty(k);
  });
});

describe('CommandPalette keyboard model', () => {
  const setup = () => {
    const ran: string[] = [];
    const onClose = vi.fn();
    const commands = ['Open network', 'Open timeline', 'Export session', 'Disabled thing'].map(
      (label, i) => ({
        id: String(i),
        label,
        disabled: label.startsWith('Disabled'),
        run: () => ran.push(label),
      }),
    );
    render(<CommandPalette commands={commands} onClose={onClose} />);
    return { ran, onClose, input: screen.getByLabelText('Command') };
  };
  const active = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent;

  it('focuses the input, hides disabled commands and navigates with arrows', () => {
    const { input, ran, onClose } = setup();
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(active()).toBe('Open network');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()).toBe('Export session');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ran).toEqual(['Open timeline']);
    expect(onClose).toHaveBeenCalled();
  });

  it('filters, resets the selection and reports no matches', () => {
    const { input, onClose } = setup();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'export' } });
    expect(active()).toBe('Export session');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching command')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('status is not conveyed by color alone', () => {
  it('badges carry an icon and a text label', () => {
    render(<Badge tone="error">Failed</Badge>);
    const badge = screen.getByText('Failed');
    expect(badge.querySelector('.badge-icon')?.textContent).toBe('✕');
    expect(badge.textContent).toBe('✕Failed');
  });

  it('active filters announce counts politely and label remove buttons', () => {
    const onRemove = vi.fn();
    render(
      <ActiveFilters
        chips={[{ id: 'm', label: 'POST', onRemove }]}
        onClearAll={() => undefined}
        shown={3}
        total={10}
        noun="requests"
      />,
    );
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter POST' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
