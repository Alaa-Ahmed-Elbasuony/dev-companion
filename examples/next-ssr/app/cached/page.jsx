import { UPSTREAM } from '../upstream';

// Rendered per request, but the upstream response is cached in the Next.js
// Data Cache for 60 s: later renders do not call the upstream.
export const dynamic = 'force-dynamic';

export default async function CachedPage() {
  const res = await fetch(`${UPSTREAM}/legacy-data`, { next: { revalidate: 60 } });
  const data = await res.json();
  return (
    <main>
      <h1>Cached fetch</h1>
      <p id="cached">Items: {data.items}</p>
    </main>
  );
}
