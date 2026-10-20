import { UPSTREAM, UPSTREAM_AUTH } from '../../upstream';

// Route Handler: one outbound call, then a JSON response.
export async function POST(request) {
  const input = await request.json();
  const res = await fetch(`${UPSTREAM}/products`, { cache: 'no-store', headers: UPSTREAM_AUTH });
  const products = await res.json();
  return Response.json({ orderId: `ord-${Date.now()}`, sku: input.sku, available: products.length });
}
