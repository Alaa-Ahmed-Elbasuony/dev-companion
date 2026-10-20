'use client';
import { useEffect, useState } from 'react';

// Client-side request made after hydration.
export default function ClientOrders() {
  const [state, setState] = useState('loading');
  useEffect(() => {
    fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'kbd-1' }),
    })
      .then((r) => r.json())
      .then((d) => setState(`created ${d.orderId}`))
      .catch(() => setState('failed'));
  }, []);
  return <p id="client-order">Client order: {state}</p>;
}
