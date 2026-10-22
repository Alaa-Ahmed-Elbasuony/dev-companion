// Builds the extension into dist/ (or dist-e2e/ with --e2e).
//   UI pages      -> Vite (React)
//   service worker -> esbuild, ES module
//   content scripts -> esbuild, IIFE (content scripts cannot be ES modules)
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { renderIcon } from './icons.mjs';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const e2e = args.has('--e2e');
const outDir = resolve(root, e2e ? 'dist-e2e' : 'dist');

const git = (...gitArgs) => {
  try {
    return execFileSync('git', gitArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Records which commit this build came from, so the extension can tell users
 * when the repository has newer changes. Builds outside a git checkout (and E2E
 * builds, which must not call GitHub) get no commit and never check. A build
 * with uncommitted extension sources is a local development build: its commit
 * does not describe what it contains, so it does not check either.
 */
function buildInfo() {
  const remote = e2e ? null : git('remote', 'get-url', 'origin');
  const repo = remote?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
  return {
    commit: e2e ? null : git('rev-parse', 'HEAD'),
    branch: e2e ? null : git('rev-parse', '--abbrev-ref', 'HEAD'),
    // Only sources count: `npm install` may touch package-lock.json on users' machines.
    dirty: !!git('status', '--porcelain', '--', 'src', 'scripts'),
    repo,
    builtAt: Date.now(),
  };
}

async function writeStatic() {
  const manifest = JSON.parse(await readFile(resolve(root, 'src/manifest.json'), 'utf8'));
  if (e2e) {
    // Test-only build: pre-grant the local mock server origin so automated tests
    // do not need to click Chrome's permission prompt. Never ship this build.
    manifest.name = 'Dev Companion (E2E test build)';
    manifest.host_permissions = ['http://127.0.0.1/*'];
  }
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(outDir, 'build-info.json'), JSON.stringify(buildInfo(), null, 2));
  await mkdir(resolve(outDir, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await writeFile(resolve(outDir, `icons/icon-${size}.png`), renderIcon(size));
  }
}

// Marks every source of a bundle as ignore-listed in its source map, so DevTools
// (and other tools that honor ignore lists) skip the recorder's wrapper frames and
// attribute console calls and requests to the page's own code.
const ignoreListPlugin = {
  name: 'ignore-list',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const mapPath = `${build.initialOptions.outfile}.map`;
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      map.ignoreList = map.sources.map((_, i) => i);
      map.x_google_ignoreList = map.ignoreList;
      await writeFile(mapPath, JSON.stringify(map));
    });
  },
};

const scriptBuilds = [
  { entry: 'src/background/service-worker.ts', out: 'service-worker.js', format: 'esm' },
  { entry: 'src/content/content-script.ts', out: 'content-script.js', format: 'iife' },
  { entry: 'src/capture/main-world.ts', out: 'main-world.js', format: 'iife', plugins: [ignoreListPlugin] },
].map(({ entry, out, format, plugins = [] }) => ({
  plugins,
  entryPoints: [resolve(root, entry)],
  outfile: resolve(outDir, out),
  bundle: true,
  format,
  target: 'chrome120',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
}));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeStatic();

if (watch) {
  for (const options of scriptBuilds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  await viteBuild({ configFile: resolve(root, 'vite.config.ts'), build: { outDir, watch: {} } });
  console.log(`Watching. Output: ${outDir}`);
} else {
  await Promise.all(scriptBuilds.map((options) => esbuild.build(options)));
  await viteBuild({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir } });
  console.log(`Built extension to ${outDir}`);
}
