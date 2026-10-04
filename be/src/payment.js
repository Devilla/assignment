// Payment abstraction. The real world has a slow, fallible network call between
// "we decided to sell this" and "we recorded the sale"; the fake keeps that seam
// (it is async and can fail) so the checkout saga is exercised honestly.
export class FakePaymentGateway {
  constructor({ delayMs = 0, shouldFail = () => false } = {}) {
    this.delayMs = delayMs;
    this.shouldFail = shouldFail;
    this.charges = [];
  }

  async charge({ reference, amountCents }) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (await this.shouldFail({ reference, amountCents })) {
      const err = new Error('payment declined');
      err.code = 'PAYMENT_DECLINED';
      throw err;
    }
    this.charges.push({ reference, amountCents });
    return { id: `pay_${reference}` };
  }
}
