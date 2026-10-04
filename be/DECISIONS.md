# DECISIONS

Time spent: **TODO: fill in your actual time.** Persistence is in-memory by choice (see below).

## System invariants
1. **No oversell:** for every product, `inventory >= 0`, and `initial = current + sum(order line quantities)` (+ in-flight reservations).
2. **One order per cart:** a cart reaches `CHECKED_OUT` at most once and maps to exactly one order.
3. **One redemption per coupon:** a coupon moves `AVAILABLE -> RESERVED -> REDEEMED` (or back to `AVAILABLE` on failure); `REDEEMED` is terminal and tied to one order.
4. **One coupon per milestone:** milestone *k* (reached when `k*n` orders exist) has at most one coupon.
5. **Order integrity:** `total = subtotal - discount`, `0 <= discount <= subtotal`, and the order stores its own line snapshots, so later product edits never change history.
6. **Report reconciliation:** the report is a pure fold over orders and coupons; `net = gross - discounts`.
7. **Failure leaves no trace:** a rejected or failed checkout changes no inventory, coupon status, or order count.

## Ambiguities and the semantics I chose
- **Price/availability change after add:** cart lines remember the price when added, but the cart view and checkout use the *current* price. If any price differs, checkout fails with `409 PRICE_CHANGED` (listing old/new) unless the client sends `acceptPriceChanges: true`. Customers are never silently charged a different amount. Availability is re-checked at checkout; carts do **not** reserve stock (abandoned carts would otherwise lock inventory).
- **Milestone counting:** every successfully placed order counts, including ones that used a coupon. Milestone *k* is at order `k*n`.
- **Coupon generation is on demand, not automatic** (admin requests it). If several milestones are unrewarded, each call issues one coupon for the lowest unrewarded milestone. So milestones are never lost, and the admin can't mint extras.
- **Coupon scope:** percent off the whole cart subtotal, one coupon per order, any customer may use it, no expiry (deferred), no minimum spend. Codes are case-insensitive.
- **Rounding:** percent discount is rounded half-up to the cent (`floor((subtotal*x + 50)/100)`), then capped at subtotal. A 100% coupon yields a 0 total, never negative. Payment is still "charged" for 0.
- **Quantity bounds:** integer 1..100 per line.
- **Payment:** a `FakePaymentGateway` behind a tiny `charge()` interface. It's async and can fail, which matters: it creates the realistic window between deciding to sell and recording the sale.
- **Admin:** `/admin/*` is administrative, no auth (as allowed).

## Decision: Reserve-then-pay-then-commit checkout
**Context:** Payment is a slow, fallible step. Checking stock, paying, then decrementing would let two checkouts both pass the check. Paying after commit risks orders without payment.
**Options considered:** (a) check → pay → decrement; (b) decrement/commit → pay → refund on failure; (c) atomically reserve stock and coupon → pay → commit or release.
**Choice:** (c).
**Why:** Competitors are rejected immediately, before any money moves; failure releases everything, so a failed payment can't burn a coupon or stock (explicit requirement).
**Consequences:** A new transient state (`CHECKING_OUT`, coupon `RESERVED`). A process crash mid-payment would strand a reservation in memory-only storage; with a database a reservation needs a TTL/sweeper (deferred).

## Decision: The cart is the idempotency key
**Context:** Clients retry checkouts after timeouts.
**Options considered:** `Idempotency-Key` header with a key store; cart status as the key.
**Choice:** Cart state machine `OPEN -> CHECKING_OUT -> CHECKED_OUT`. A repeat on `CHECKED_OUT` returns the stored order (200 + `Idempotent-Replayed`). A repeat during `CHECKING_OUT` awaits the same in-flight promise, so the duplicate gets the identical result and nothing runs twice. A retry with a different coupon gets `409 CHECKOUT_PARAMS_MISMATCH`.
**Why:** A cart can only ever produce one order, so the cart ID already uniquely identifies the operation. No key bookkeeping or expiry, and no way for a client to forget the header.
**Consequences:** Doesn't generalize to non-cart operations (e.g. refunds would need real keys). After a *failed* checkout the cart reopens, so a retry is a fresh attempt, which is what we want.

## Decision: Single-threaded atomic sections instead of locks (in-memory)
**Context:** Need check-then-act correctness under overlapping requests.
**Options considered:** per-resource mutexes; a serialized queue; relying on Node's run-to-completion semantics; SQLite transactions.
**Choice:** Every invariant-protecting read-modify-write is a synchronous block with no `await`, hence atomic in Node. The single `await` (payment) sits between two such blocks.
**Why:** Simplest thing that is demonstrably correct; locks would add deadlock risk for no benefit. Tests inject a 5 ms payment delay so requests truly interleave across the await, and a mutation check (removing the reservation) makes three tests fail.
**Consequences:** Correct only for a single process. The rule for contributors: never add an `await` inside those blocks.

## Decision: Integer cents and integer-only discount math
Floats are never stored or summed. Prices, line totals, discounts, and revenue are integers. `percentDiscountCents` uses integer arithmetic only (values far below 2^53). Chosen over a decimal library to keep zero dependencies.

## Decision: Coupons reserved during checkout (three-state)
**Options:** mark `REDEEMED` on checkout start (loses coupon on failure); mark on success only (two concurrent checkouts both pass the check).
**Choice:** `AVAILABLE -> RESERVED -> REDEEMED`, reverting on failure. The reservation is the compare-and-set that makes concurrent redemption impossible. The report exposes `reserved` so counts always sum.

## Decision: Distinguishable error model
Stable `code` strings with structured `details`, HTTP status by category: 400 malformed, 402 payment, 404 missing, 409 state conflicts the client can resolve (stock, price, coupon taken), 422 well-formed but semantically unusable (empty cart, unknown coupon). Clients branch on `code`. Unknown failures are a generic 500 with no leakage.

## Transaction / concurrency / idempotency summary
See the three decisions above. Checkout: atomic validate+reserve, payment, atomic commit-or-rollback. Coupon generation: one atomic block that selects the lowest unrewarded milestone and inserts the coupon, so double-clicks yield one coupon. Reports only read.

## Decision: TypeScript, compiled with tsc
Strict TypeScript models the state machines (`CartStatus`, `CouponStatus`) and domain records in `src/types.ts`, so illegal states are compile errors. Compiled with plain `tsc` to `dist/` rather than relying on Node's type stripping or a runner like tsx, to keep Node >= 20 support and avoid extra tooling. Cost: a build step before start/test.

## Implemented vs deferred
Implemented: all required endpoints, seeded products, price-change policy, idempotent/concurrent checkout, coupon lifecycle, report, 9 tests incl. concurrency, docs.
Deferred: durable storage; reservation expiry for crashed checkouts; coupon expiry/min-spend; auth; pagination of coupon list; request rate limiting; refunds/cancellation; OpenAPI file (endpoint table in `SERVICE.md` instead).

## Evolving to multiple instances / production
- Postgres. Checkout reservation: one transaction doing `UPDATE products SET inventory = inventory - $q WHERE id=$1 AND inventory >= $q` (0 rows = insufficient stock); coupon `UPDATE coupons SET status='RESERVED' WHERE code=$1 AND status='AVAILABLE'`; cart `UPDATE ... SET status='CHECKING_OUT' WHERE status='OPEN'`. Row-level conditional updates replace the in-process atomicity.
- Unique constraints: `orders.cart_id UNIQUE`, `coupons.milestone UNIQUE` (generation becomes `INSERT ... ON CONFLICT DO NOTHING` loop), `coupons.redeemed_by_order_id UNIQUE`.
- Order sequence from a transactional counter or `count(*)` inside the generation transaction.
- Joining an in-flight checkout becomes polling/`409 IN_PROGRESS` + Retry-After, or an advisory lock on the cart; the payment provider's own idempotency key (derived from cart ID) protects against double charges.
- A sweeper releases reservations older than a timeout; an outbox for payment-confirmed events. Report becomes SQL aggregates (or a read replica).

## AI usage
**TODO: edit to reflect your own experience before submitting.** This submission was produced with Claude Code (the assistant wrote the code, tests and docs in one session; the human owner reviewed the result). Concretely verified rather than trusted: tests run under an artificially slow payment gateway so requests interleave across the `await`, and a mutation check (deleting the stock-reservation line) confirmed three tests fail. One small correction made along the way: the `npm test` script initially passed a directory to `node --test`, which fails on Node 24, so it was changed to a glob. Add an example where you yourself corrected or redirected the AI.

## What I'd examine first with two more hours
1. Port storage to SQLite/Postgres with the conditional-update scheme above and rerun the same tests against it, since in-memory atomicity hides real isolation bugs.
2. Reservation expiry for stranded `CHECKING_OUT` carts and a test that simulates a crash.
3. Property-style test: random interleavings of checkout/retry/price change/restock, asserting the invariants after every run.
4. Coupon expiry and per-customer rules once the business decides them.
