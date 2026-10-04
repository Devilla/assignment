import { createServer, createShop } from '../src/app.js';
import { FakePaymentGateway } from '../src/payment.js';

export async function start({ n = 3, x = 10, payment, products } = {}) {
  const gateway = payment ?? new FakePaymentGateway({ delayMs: 5 }); // delay forces real interleaving
  const shop = createShop({ config: { milestoneN: n, couponPercent: x }, payment: gateway, products });
  const server = createServer(shop);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const cartWith = async (productId, quantity) => {
    const { body: cart } = await call('POST', '/carts');
    const added = await call('POST', `/carts/${cart.id}/items`, { productId, quantity });
    if (added.status !== 201) throw new Error(`setup failed: ${JSON.stringify(added.body)}`);
    return cart.id;
  };
  return { shop, gateway, call, cartWith, close: () => server.close() };
}
