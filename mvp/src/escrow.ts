import { newId } from "./util.js";

export type EscrowState = "held" | "released" | "refunded";
export interface EscrowProvider {
  name: string;
  hold(dealId: string, amount: number): Promise<{ ref: string }>;
  release(ref: string): Promise<void>;
  refund(ref: string): Promise<void>;
}

/**
 * Stand-in for a licensed partner such as Stripe Connect. The platform never holds money:
 * in production these three calls map to PaymentIntent (manual capture) / capture+transfer / cancel or refund.
 */
export class SimulatedEscrow implements EscrowProvider {
  name = "simulated";
  private state = new Map<string, EscrowState>();
  failNext = false; // test hook: simulate a partner failure
  async hold(_dealId: string, _amount: number) {
    if (this.failNext) { this.failNext = false; throw new Error("partner unavailable"); }
    const ref = newId("sim");
    this.state.set(ref, "held");
    return { ref };
  }
  async release(ref: string) {
    if (this.state.get(ref) !== "held") throw new Error(`cannot release ${this.state.get(ref)}`);
    this.state.set(ref, "released");
  }
  async refund(ref: string) {
    if (this.state.get(ref) !== "held") throw new Error(`cannot refund ${this.state.get(ref)}`);
    this.state.set(ref, "refunded");
  }
}

export class StripeConnectEscrow implements EscrowProvider {
  name = "stripe_connect";
  private fail(): never { throw new Error("Stripe Connect is not configured: set up the partner account (MVP dependency: approved before week 9)."); }
  async hold(): Promise<{ ref: string }> { return this.fail(); }
  async release(): Promise<void> { return this.fail(); }
  async refund(): Promise<void> { return this.fail(); }
}
