export function loadConfig(env = process.env) {
  const n = Number(env.ORDER_MILESTONE_N ?? 5);
  const x = Number(env.COUPON_PERCENT_X ?? 10);
  if (!Number.isInteger(n) || n < 1) throw new Error('ORDER_MILESTONE_N must be an integer >= 1');
  if (!Number.isInteger(x) || x < 1 || x > 100) throw new Error('COUPON_PERCENT_X must be an integer 1..100');
  return { milestoneN: n, couponPercent: x, port: Number(env.PORT ?? 3000) };
}
