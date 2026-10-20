import { UPSTREAM } from '../upstream';

// Used for concurrent-navigation tests: each render waits on a tagged slow upstream call.
export const dynamic = 'force-dynamic';

export default async function SlowPage({ searchParams }) {
  const { tag = 'none' } = await searchParams;
  const res = await fetch(`${UPSTREAM}/slow?ms=600&tag=${encodeURIComponent(tag)}`, { cache: 'no-store' });
  const data = await res.json();
  return <p id="slow">tag {data.tag}</p>;
}
