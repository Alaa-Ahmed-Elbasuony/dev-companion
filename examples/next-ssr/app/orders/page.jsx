import { UPSTREAM, UPSTREAM_AUTH } from '../upstream';
import ClientOrders from './client-orders';

// Rendered on every request: two outbound calls during server rendering,
// one succeeds and one fails (503).
export const dynamic = 'force-dynamic';

async function load(path) {
  const res = await fetch(`${UPSTREAM}${path}`, { cache: 'no-store', headers: UPSTREAM_AUTH });
  return { status: res.status, body: await res.json() };
}

export default async function OrdersPage() {
  const [products, inventory] = await Promise.all([load('/products'), load('/inventory')]);
  return (
    <main>
      <h1>Orders</h1>
      <p id="products">
        Products: {products.status === 200 ? products.body.map((p) => p.name).join(', ') : 'error'}
      </p>
      <p id="inventory">Inventory: {inventory.status === 200 ? 'ok' : `unavailable (${inventory.status})`}</p>
      <ClientOrders />
    </main>
  );
}
