# Checkout & Rewards Service

Zero runtime dependencies. Requires Node >= 20 (developed on 24).

```bash
cd be
npm start            # http://localhost:3000   (PORT, ORDER_MILESTONE_N=5, COUPON_PERCENT_X=10)
npm test             # node:test, no install step needed
```

Data is in memory and re-seeded on every start (6 products; `sneaker` has only 3 units).
Money is always integer cents (`*Cents`). Admin endpoints live under `/admin` (no auth implemented).

## Errors
All errors: `{ "error": { "code": "...", "message": "...", "details": {...} } }`. Branch on `code`.

| Status | Codes |
|---|---|
| 400 | `INVALID_JSON`, `VALIDATION_ERROR`, `INVALID_QUANTITY`, `BODY_TOO_LARGE` |
| 402 | `PAYMENT_FAILED` (nothing reserved; safe to retry) |
| 404 | `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ITEM_NOT_IN_CART`, `ORDER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `CART_NOT_OPEN`, `COUPON_UNAVAILABLE`, `CHECKOUT_PARAMS_MISMATCH`, `NO_ELIGIBLE_MILESTONE` |
| 422 | `EMPTY_CART`, `COUPON_INVALID` |

## Endpoints

| Method & path | Body | Success | Notes / errors |
|---|---|---|---|
| `GET /products` | | 200 `{products[]}` | |
| `POST /carts` | | 201 cart | |
| `GET /carts/:id` | | 200 cart | Shows *current* prices, `priceChanged`, `inStock`, `subtotalCents`. 404 |
| `POST /carts/:id/items` | `{productId, quantity}` | 201 cart | Adding an existing product increases its quantity. `INVALID_QUANTITY` (integer 1..100), `PRODUCT_NOT_FOUND`, `INSUFFICIENT_STOCK`, `CART_NOT_OPEN` |
| `PUT /carts/:id/items/:productId` | `{quantity}` | 200 cart | Same errors; `ITEM_NOT_IN_CART` |
| `DELETE /carts/:id/items/:productId` | | 200 cart | `ITEM_NOT_IN_CART`, `CART_NOT_OPEN` |
| `POST /carts/:id/checkout` | `{couponCode?, acceptPriceChanges?}` | **201** new order, **200** + `Idempotent-Replayed: true` for a retry/duplicate | `EMPTY_CART`, `INSUFFICIENT_STOCK` (details list items), `PRICE_CHANGED`, `COUPON_INVALID`, `COUPON_UNAVAILABLE`, `CHECKOUT_PARAMS_MISMATCH`, `PAYMENT_FAILED` |
| `GET /orders/:id` | | 200 order | Order holds line snapshots (name, unit price), subtotal, coupon, discount, total |
| `POST /admin/coupons` | | 201 coupon | `NO_ELIGIBLE_MILESTONE` (details: `ordersPlaced`, `nextMilestoneAtOrder`) |
| `GET /admin/coupons` | | 200 `{coupons[]}` | Needed to find codes / reconcile |
| `GET /admin/report` | | 200 report | Read-only |
| `PATCH /admin/products/:id` | `{priceCents?, inventory?}` | 200 product | For restocking / price changes |

### Example
```bash
CART=$(curl -s -XPOST localhost:3000/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -XPOST localhost:3000/carts/$CART/items -d '{"productId":"widget","quantity":2}'
curl -s -XPOST localhost:3000/carts/$CART/checkout -d '{}'     # 201
curl -s -XPOST localhost:3000/carts/$CART/checkout -d '{}'     # 200, same order, Idempotent-Replayed: true
curl -s localhost:3000/admin/report
```

Report shape: `totalOrders`, `purchasedQuantityByProduct`, `grossRevenueCents`, `totalDiscountsCents`,
`netRevenueCents`, `coupons{generated, available, reserved, redeemed}` (`generated = available + reserved + redeemed`;
`reserved` is a coupon held by an in-flight checkout).
