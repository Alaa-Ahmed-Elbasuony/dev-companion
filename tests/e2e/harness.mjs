// Shared helpers for the E2E suites: launching Chrome with the built test
// extension, reading its IndexedDB and talking to the service worker.
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

export const root = resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createReporter() {
  const results = [];
  return {
    results,
    async check(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  PASS  ${name}`);
      } catch (err) {
        results.push({ name, ok: false, err });
        console.log(`  FAIL  ${name}\n        ${err?.message ?? err}`);
      }
    },
    skip(name, reason) {
      results.push({ name, ok: true, skipped: true });
      console.log(`  SKIP  ${name}\n        ${reason}`);
    },
    summary(label) {
      const failed = results.filter((r) => !r.ok);
      const skipped = results.filter((r) => r.skipped).length;
      console.log(
        `\n${label}: ${results.length - failed.length - skipped}/${results.length - skipped} checks passed` +
          (skipped ? `, ${skipped} skipped` : ''),
      );
      return failed.length;
    },
  };
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function watchdog(ms, label) {
  const t = setTimeout(() => {
    console.log(`${label} watchdog: exceeded ${ms / 1000}s`);
    process.exit(3);
  }, ms);
  t.unref();
}

export async function launchWithExtension(profile) {
  const userDataDir = resolve(root, `.e2e-profile/${profile}`);
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: !process.env.HEADFUL,
    pipe: true,
    protocolTimeout: 30_000,
    enableExtensions: [resolve(root, 'dist-e2e')],
    userDataDir,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/service-worker.js'),
    { timeout: 15_000 },
  );
  const extId = new URL(swTarget.url()).host;
  return { browser, extId, swTarget };
}

export async function launchPlain() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: !process.env.HEADFUL,
    pipe: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

/** Reads every object store of the extension's database from an extension page. */
export function readDb(extPage, stores) {
  return extPage.evaluate(async (names) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('dev-companion');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (name) =>
      new Promise((res) => {
        if (!db.objectStoreNames.contains(name)) return res([]);
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => res(r.result);
      });
    const out = {};
    for (const name of names) out[name] = await all(name);
    db.close();
    return out;
  }, stores);
}

/** Polls until `predicate(db)` returns a truthy value. */
export async function waitForDb(extPage, stores, predicate, label, timeout = 8000) {
  const start = Date.now();
  let last;
  for (;;) {
    const db = await readDb(extPage, stores);
    last = predicate(db);
    if (last) return { value: last, db };
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

/** Sends a worker message on behalf of the tab whose URL starts with `prefix`. */
export function tabRequest(extPage, prefix, type, extra = {}) {
  return extPage.evaluate(
    async (type, extra, prefix) => {
      const [tab] = await chrome.tabs.query({ url: `${prefix}/*` });
      return chrome.runtime.sendMessage({ type, tabId: tab.id, url: tab.url, ...extra });
    },
    type,
    extra,
    prefix,
  );
}
