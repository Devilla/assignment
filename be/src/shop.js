import { randomBytes, randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound, unprocessable, ApiError } from './errors.js';
import { percentDiscountCents } from './money.js';

const MAX_QTY_PER_LINE = 100;

/**
 * In-memory domain core.
 *
 * CONCURRENCY MODEL: Node runs JS on one thread, so any stretch of code with no `await`
 * is atomic with respect to other requests. Every invariant-protecting check-then-write
 * below lives in such a synchronous stretch. The only `await` in the whole domain is the
 * payment call, and it sits BETWEEN two atomic sections:
 *
 *   [atomic] validate + reserve stock + reserve coupon + mark cart CHECKING_OUT
 *   [await ] payment
 *   [atomic] commit order (or roll the reservations back)
 *
 * Reserving before paying means a second checkout racing for the same stock or coupon
 * is rejected immediately, and a failed payment releases everything it held.
 * With a real database the same sections become transactions (see DECISIONS.md).
 */
export class Shop {
  constructor({ config, payment, products }) {
    this.config = config;
    this.payment = payment;
    this.products = new Map(products.map((p) => [p.id, { ...p }]));
    this.carts = new Map();
    this.orders = new Map();
    this.coupons = new Map(); // code -> coupon
    this.orderSeq = 0;
  }

  // ---------- products ----------
  listProducts() {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  getProduct(id) {
    const p = this.products.get(id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND', `Product '${id}' does not exist`);
    return p;
  }

  /** Admin: change price and/or inventory. */
  updateProduct(id, body) {
    const p = this.getProduct(id);
    const { priceCents, inventory } = body ?? {};
    if (priceCents === undefined && inventory === undefined) {
      throw badRequest('VALIDATION_ERROR', 'Provide priceCents and/or inventory');
    }
    if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 0)) {
      throw badRequest('VALIDATION_ERROR', 'priceCents must be a non-negative integer');
    }
    if (inventory !== undefined && (!Number.isSafeInteger(inventory) || inventory < 0)) {
      throw badRequest('VALIDATION_ERROR', 'inventory must be a non-negative integer');
    }
    if (priceCents !== undefined) p.priceCents = priceCents;
    if (inventory !== undefined) p.inventory = inventory;
    return { ...p };
  }

  // ---------- carts ----------
  createCart() {
    const cart = { id: randomUUID(), status: 'OPEN', items: new Map(), createdAt: now() };
    this.carts.set(cart.id, cart);
    return this.viewCart(cart);
  }

  getCart(id) {
    const c = this.carts.get(id);
    if (!c) throw notFound('CART_NOT_FOUND', `Cart '${id}' does not exist`);
    return c;
  }

  viewCart(cart) {
    let subtotal = 0;
    const items = [...cart.items.values()].map((it) => {
      const p = this.products.get(it.productId);
      const lineTotalCents = p.priceCents * it.quantity;
      subtotal += lineTotalCents;
      return {
        productId: it.productId,
        name: p.name,
        quantity: it.quantity,
        unitPriceCents: p.priceCents, // current price: what checkout would charge
        lineTotalCents,
        priceWhenAddedCents: it.priceWhenAddedCents,
        priceChanged: p.priceCents !== it.priceWhenAddedCents,
        inStock: p.inventory >= it.quantity,
        available: p.inventory,
      };
    });
    return {
      id: cart.id,
      status: cart.status,
      currency: 'USD',
      items,
      subtotalCents: subtotal,
      orderId: cart.orderId ?? null,
    };
  }

  assertOpen(cart) {
    if (cart.status !== 'OPEN') {
      throw conflict('CART_NOT_OPEN', `Cart is ${cart.status} and can no longer be modified`, { status: cart.status });
    }
  }

  static validateQuantity(q, { allowZero = false } = {}) {
    if (!Number.isInteger(q) || q < (allowZero ? 0 : 1) || q > MAX_QTY_PER_LINE) {
      throw badRequest('INVALID_QUANTITY', `quantity must be an integer between ${allowZero ? 0 : 1} and ${MAX_QTY_PER_LINE}`);
    }
  }

  /** Adding an already-present product increases its quantity. */
  addItem(cartId, body) {
    const cart = this.getCart(cartId);
    this.assertOpen(cart);
    const { productId, quantity } = body ?? {};
    if (typeof productId !== 'string' || !productId) throw badRequest('VALIDATION_ERROR', 'productId is required');
    Shop.validateQuantity(quantity);
    const product = this.getProduct(productId);
    const newQty = (cart.items.get(productId)?.quantity ?? 0) + quantity;
    this.checkLineQuantity(product, newQty);
    cart.items.set(productId, { productId, quantity: newQty, priceWhenAddedCents: product.priceCents });
    return this.viewCart(cart);
  }

  setItemQuantity(cartId, productId, body) {
    const cart = this.getCart(cartId);
    this.assertOpen(cart);
    if (!cart.items.has(productId)) throw notFound('ITEM_NOT_IN_CART', `Product '${productId}' is not in the cart`);
    const { quantity } = body ?? {};
    Shop.validateQuantity(quantity);
    const product = this.getProduct(productId);
    this.checkLineQuantity(product, quantity);
    cart.items.set(productId, { productId, quantity, priceWhenAddedCents: product.priceCents });
    return this.viewCart(cart);
  }

  removeItem(cartId, productId) {
    const cart = this.getCart(cartId);
    this.assertOpen(cart);
    if (!cart.items.delete(productId)) throw notFound('ITEM_NOT_IN_CART', `Product '${productId}' is not in the cart`);
    return this.viewCart(cart);
  }

  // Early, advisory stock check at cart time (stock is NOT reserved by carts).
  checkLineQuantity(product, qty) {
    if (qty > MAX_QTY_PER_LINE) throw badRequest('INVALID_QUANTITY', `at most ${MAX_QTY_PER_LINE} per line`);
    if (qty > product.inventory) {
      throw conflict('INSUFFICIENT_STOCK', `Only ${product.inventory} of '${product.id}' available`, {
        productId: product.id, requested: qty, available: product.inventory,
      });
    }
  }

  // ---------- checkout ----------
  /**
   * Idempotency: the cart is the natural idempotency key (one cart -> at most one order).
   *  - cart OPEN             -> run checkout
   *  - cart CHECKING_OUT     -> join the in-flight attempt (same result for both callers)
   *  - cart CHECKED_OUT      -> replay the stored order, no side effects
   * A retry that changes the coupon is a different request and is rejected.
   */
  async checkout(cartId, body) {
    const cart = this.getCart(cartId);
    const couponCode = normalizeCode(body?.couponCode);
    const acceptPriceChanges = body?.acceptPriceChanges === true;

    if (cart.status === 'CHECKED_OUT' || cart.status === 'CHECKING_OUT') {
      if (cart.checkoutCoupon !== couponCode) {
        throw conflict('CHECKOUT_PARAMS_MISMATCH',
          'This cart already has a checkout with a different coupon', { couponCode: cart.checkoutCoupon });
      }
      if (cart.status === 'CHECKED_OUT') return { order: this.orders.get(cart.orderId), replayed: true };
      const order = await cart.inflight; // throws the same error if the attempt fails
      return { order, replayed: true };
    }

    // ---- atomic section 1: validate and reserve (no awaits until payment) ----
    if (cart.items.size === 0) throw unprocessable('EMPTY_CART', 'Cannot check out an empty cart');

    const lines = [];
    const priceChanges = [];
    const shortages = [];
    for (const it of cart.items.values()) {
      const p = this.products.get(it.productId);
      if (p.inventory < it.quantity) {
        shortages.push({ productId: p.id, requested: it.quantity, available: p.inventory });
      }
      if (p.priceCents !== it.priceWhenAddedCents) {
        priceChanges.push({ productId: p.id, priceWhenAddedCents: it.priceWhenAddedCents, currentPriceCents: p.priceCents });
      }
      lines.push({
        productId: p.id, name: p.name, quantity: it.quantity,
        unitPriceCents: p.priceCents, lineTotalCents: p.priceCents * it.quantity,
      });
    }
    if (shortages.length) throw conflict('INSUFFICIENT_STOCK', 'Some items are no longer available in the requested quantity', { items: shortages });
    if (priceChanges.length && !acceptPriceChanges) {
      throw conflict('PRICE_CHANGED', 'Prices changed since items were added; review the cart and retry with acceptPriceChanges=true', { items: priceChanges });
    }

    let coupon = null;
    if (couponCode) {
      coupon = this.coupons.get(couponCode);
      if (!coupon) throw unprocessable('COUPON_INVALID', `Coupon '${couponCode}' does not exist`);
      if (coupon.status !== 'AVAILABLE') {
        throw conflict('COUPON_UNAVAILABLE', `Coupon is ${coupon.status}`, { status: coupon.status });
      }
    }

    const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
    const discountCents = coupon ? percentDiscountCents(subtotalCents, coupon.percent) : 0;
    const totalCents = subtotalCents - discountCents;

    for (const l of lines) this.products.get(l.productId).inventory -= l.quantity;
    if (coupon) coupon.status = 'RESERVED';
    cart.status = 'CHECKING_OUT';
    cart.checkoutCoupon = couponCode;
    // ---- end atomic section 1 ----

    cart.inflight = this.payAndCommit({ cart, lines, coupon, subtotalCents, discountCents, totalCents });
    cart.inflight.catch(() => {}); // avoid unhandled-rejection noise; callers await it themselves
    const order = await cart.inflight;
    return { order, replayed: false };
  }

  async payAndCommit({ cart, lines, coupon, subtotalCents, discountCents, totalCents }) {
    let payment;
    try {
      payment = await this.payment.charge({ reference: cart.id, amountCents: totalCents });
    } catch (err) {
      // ---- atomic rollback: release everything section 1 held ----
      for (const l of lines) this.products.get(l.productId).inventory += l.quantity;
      if (coupon) coupon.status = 'AVAILABLE';
      cart.status = 'OPEN';
      cart.checkoutCoupon = undefined;
      cart.inflight = undefined;
      throw new ApiError(402, 'PAYMENT_FAILED', 'Payment was not successful; nothing was reserved or charged', { reason: err.code ?? 'ERROR' });
    }
    // ---- atomic section 2: commit ----
    const order = {
      id: randomUUID(),
      sequence: ++this.orderSeq,
      cartId: cart.id,
      currency: 'USD',
      lines,
      subtotalCents,
      coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null,
      discountCents,
      totalCents,
      paymentId: payment.id,
      createdAt: now(),
    };
    this.orders.set(order.id, order);
    if (coupon) {
      coupon.status = 'REDEEMED';
      coupon.redeemedByOrderId = order.id;
    }
    cart.status = 'CHECKED_OUT';
    cart.orderId = order.id;
    return order;
  }

  getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw notFound('ORDER_NOT_FOUND', `Order '${id}' does not exist`);
    return o;
  }

  // ---------- admin: coupons & reporting ----------
  /**
   * Milestone k is reached once k*n orders are placed. Each milestone yields exactly one
   * coupon. Generation is idempotent per milestone: it picks the lowest milestone that
   * has been reached and has no coupon yet. Runs in one synchronous section, so two
   * simultaneous admin calls can never both claim the same milestone.
   */
  generateCoupon() {
    const { milestoneN: n, couponPercent: x } = this.config;
    const reached = Math.floor(this.orders.size / n);
    const done = new Set([...this.coupons.values()].map((c) => c.milestone));
    let milestone = null;
    for (let k = 1; k <= reached; k++) if (!done.has(k)) { milestone = k; break; }
    if (milestone === null) {
      throw conflict('NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached', {
        ordersPlaced: this.orders.size,
        nextMilestoneAtOrder: (reached + 1) * n,
      });
    }
    const coupon = {
      code: `SAVE${x}-${randomBytes(4).toString('hex').toUpperCase()}`,
      percent: x,
      milestone,
      status: 'AVAILABLE',
      createdAt: now(),
    };
    this.coupons.set(coupon.code, coupon);
    return { ...coupon };
  }

  listCoupons() {
    return [...this.coupons.values()].map((c) => ({ ...c }));
  }

  report() {
    const byProduct = new Map();
    let gross = 0, discounts = 0, net = 0;
    for (const o of this.orders.values()) {
      gross += o.subtotalCents; discounts += o.discountCents; net += o.totalCents;
      for (const l of o.lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.quantity);
    }
    const counts = { AVAILABLE: 0, RESERVED: 0, REDEEMED: 0 };
    for (const c of this.coupons.values()) counts[c.status]++;
    return {
      currency: 'USD',
      totalOrders: this.orders.size,
      purchasedQuantityByProduct: Object.fromEntries(byProduct),
      grossRevenueCents: gross,
      totalDiscountsCents: discounts,
      netRevenueCents: net,
      coupons: {
        generated: this.coupons.size,
        available: counts.AVAILABLE,
        reserved: counts.RESERVED, // held by an in-flight checkout; generated = available + reserved + redeemed
        redeemed: counts.REDEEMED,
      },
    };
  }
}

const now = () => new Date().toISOString();
const normalizeCode = (c) => (typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : undefined);
