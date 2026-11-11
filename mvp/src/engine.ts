/**
 * Negotiation engine. One engine serves both sides, so deal quality never depends
 * on which AI model the buyer uses. Prices are integer cents.
 *
 * - Strategy never reveals a private limit: each side stops a private random margin
 *   short of it (stop-short), so the last offer is never the walk-away price.
 * - A hard guard re-checks every offer; a bug throws, it never produces a bad deal.
 */
import { mulberry32 } from "./util.js";

export interface VendorTerms {
  list: number;
  floor: number;
  target: number;
  maxDiscountPct: number;
  warrantyOptions: number[];
  warrantyCostPerDay: number;
  leadDays: number;
}
export interface BuyerTerms {
  budget: number;
  warrantyValuePerDay: number;
  deadlineDays?: number | null;
}
export interface Turn {
  seq: number;
  side: "buyer" | "vendor" | "mediator";
  kind: "offer" | "counter" | "accept";
  price: number;
  warrantyDays: number;
}
export interface NegotiationResult {
  agreed: boolean;
  price: number;
  warrantyDays: number;
  turns: Turn[];
  reason: "ok" | "price" | "delivery" | "no_overlap";
}

export class MandateViolation extends Error {}

const STEP = 100; // round prices to whole dollars
const roundStep = (c: number) => Math.round(c / STEP) * STEP;

/** The lowest price the vendor can ever be asked to accept, before the stop-short cushion. */
export const vendorHardMin = (v: VendorTerms) =>
  Math.max(v.floor, Math.round(v.list * (1 - v.maxDiscountPct / 100)));

export function assertVendorOffer(v: VendorTerms, price: number) {
  if (price < v.floor) throw new MandateViolation(`vendor offer ${price} below floor ${v.floor}`);
}
export function assertBuyerOffer(b: BuyerTerms, price: number) {
  if (price > b.budget) throw new MandateViolation(`buyer offer ${price} above budget ${b.budget}`);
}

export function negotiate(v: VendorTerms, b: BuyerTerms, seed: number, rounds = 8): NegotiationResult {
  const rnd = mulberry32(seed);
  const turns: Turn[] = [];
  let seq = 0;
  const fail = (reason: NegotiationResult["reason"]): NegotiationResult => ({
    agreed: false, price: 0, warrantyDays: 0, turns, reason,
  });

  if (b.deadlineDays != null && b.deadlineDays < v.leadDays) return fail("delivery");

  const hardMin = vendorHardMin(v);
  // private stop-short margins (never leaked, redrawn every negotiation)
  const vendorLow = hardMin + Math.round(rnd() * 0.08 * Math.max(0, v.list - hardMin));
  const buyerCeiling = b.budget - Math.round(rnd() * 0.06 * b.budget);

  // Warranty: include the longest option the buyer values at least as much as it costs the vendor,
  // as long as the vendor's cost still fits under the buyer's ceiling.
  let warrantyDays = 0;
  for (const d of [...v.warrantyOptions].sort((x, y) => y - x)) {
    if (d > 0 && b.warrantyValuePerDay >= v.warrantyCostPerDay && vendorLow + v.warrantyCostPerDay * d <= buyerCeiling) {
      warrantyDays = d;
      break;
    }
  }
  const low = vendorLow + v.warrantyCostPerDay * warrantyDays;

  if (buyerCeiling < low) return fail("price");

  const open = roundStep(Math.min(buyerCeiling, v.list) * 0.7);
  const ask = (r: number) => Math.max(low, Math.round(v.list - (v.list - low) * Math.pow(r / rounds, 1.4)));
  const bid = (r: number) => Math.min(buyerCeiling, Math.round(open + (buyerCeiling - open) * Math.pow(r / rounds, 1.4)));

  turns.push({ seq: seq++, side: "vendor", kind: "offer", price: roundStep(Math.max(v.list, low)), warrantyDays });
  for (let r = 1; r <= rounds; r++) {
    const o = bid(r);
    assertBuyerOffer(b, o);
    turns.push({ seq: seq++, side: "buyer", kind: "offer", price: o, warrantyDays });
    const a = ask(r);
    assertVendorOffer(v, a);
    if (o >= a) {
      // Crossed: settle at the midpoint, which lies between the vendor's ask and the buyer's offer.
      let price = Math.min(roundStep((o + a) / 2), buyerCeiling);
      price = Math.max(price, low);
      assertVendorOffer(v, price);
      assertBuyerOffer(b, price);
      turns.push({ seq: seq++, side: "vendor", kind: "accept", price, warrantyDays });
      return { agreed: true, price, warrantyDays, turns, reason: "ok" };
    }
    turns.push({ seq: seq++, side: "vendor", kind: "counter", price: a, warrantyDays });
  }
  // Deadlock with overlap remaining: blind mediator picks a random point inside the overlap.
  const price = Math.max(low, Math.min(buyerCeiling, roundStep(low + rnd() * (buyerCeiling - low))));
  assertVendorOffer(v, price);
  assertBuyerOffer(b, price);
  turns.push({ seq: seq++, side: "mediator", kind: "accept", price, warrantyDays });
  return { agreed: true, price, warrantyDays, turns, reason: "ok" };
}
