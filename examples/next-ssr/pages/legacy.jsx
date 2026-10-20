import { get } from 'node:http';

// Pages Router with getServerSideProps, using node:http instead of fetch.
function getJson(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { authorization: 'Bearer upstream-secret-abc123' } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }).on('error', reject);
  });
}

export async function getServerSideProps() {
  const upstream = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3101';
  const data = await getJson(`${upstream}/legacy-data`);
  return { props: { items: data.body.items, status: data.status } };
}

export default function Legacy({ items, status }) {
  return (
    <main>
      <h1>Legacy (Pages Router)</h1>
      <p id="legacy">
        {items} items (upstream {status})
      </p>
    </main>
  );
}
