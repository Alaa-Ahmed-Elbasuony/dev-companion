// Starts the upstream API and `next dev` with Dev Companion tracing enabled.
//   npm run dev:traced
import { spawn } from 'node:child_process';
import { startUpstream } from '../upstream.mjs';

await startUpstream();
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '-p', process.env.PORT ?? '3100'],
  { stdio: 'inherit', env: { ...process.env, DEV_COMPANION_TRACING: '1' } },
);
child.on('exit', (code) => process.exit(code ?? 0));
