// No data fetching: prerendered by `next build`. In `next dev` it is still
// rendered on request, so cache/static behavior is only meaningful with `next start`.
export default function StaticPage() {
  return (
    <main>
      <h1>Static page</h1>
      <p id="static">This page does not fetch anything.</p>
    </main>
  );
}
