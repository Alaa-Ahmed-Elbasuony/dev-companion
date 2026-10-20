// Next.js instrumentation hook. Dev Companion tracing only starts when
// DEV_COMPANION_TRACING=1, and never in production, during `next build`, or in
// the Edge runtime. Remove this file (and the dependency) to uninstall.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { register: registerTracing } = await import('@dev-companion/server-tracer');
  await registerTracing({ serviceName: 'next-ssr-example' });
}
