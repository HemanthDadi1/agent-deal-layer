import { describe, it, expect } from "vitest";
import { negotiate, vendorHardMin, type VendorTerms } from "../src/engine.js";

const v: VendorTerms = { list: 90_000, floor: 78_000, target: 85_000, maxDiscountPct: 15, warrantyOptions: [0, 90], warrantyCostPerDay: 10, leadDays: 2 };

describe("engine", () => {
  it("never goes below floor or above budget in 1,000 random negotiations", () => {
    let agreed = 0;
    for (let i = 0; i < 1000; i++) {
      const budget = Math.round(40_000 + ((i * 7919) % 70_000));
      const r = negotiate(v, { budget, warrantyValuePerDay: i % 3 ? 25 : 0, deadlineDays: i % 5 ? 7 : 1 }, i);
      if (r.agreed) {
        agreed++;
        expect(r.price).toBeGreaterThanOrEqual(v.floor);
        expect(r.price).toBeLessThanOrEqual(budget);
        for (const t of r.turns) {
          if (t.side === "vendor") expect(t.price).toBeGreaterThanOrEqual(v.floor);
          if (t.side === "buyer") expect(t.price).toBeLessThanOrEqual(budget);
        }
      }
    }
    expect(agreed).toBeGreaterThan(100);
  });

  it("does not deal when budget is below the vendor's minimum", () => {
    expect(negotiate(v, { budget: 70_000, warrantyValuePerDay: 0 }, 1).agreed).toBe(false);
  });

  it("fails on delivery when the deadline is shorter than lead time", () => {
    const r = negotiate(v, { budget: 90_000, warrantyValuePerDay: 0, deadlineDays: 1 }, 1);
    expect(r.agreed).toBe(false);
    expect(r.reason).toBe("delivery");
  });

  it("is deterministic for the same inputs, whatever model drives the buyer", () => {
    const a = negotiate(v, { budget: 88_000, warrantyValuePerDay: 20 }, 42);
    const b = negotiate(v, { budget: 88_000, warrantyValuePerDay: 20 }, 42);
    expect(a).toEqual(b);
  });

  it("includes a warranty when the buyer values it above the vendor's cost", () => {
    const r = negotiate(v, { budget: 90_000, warrantyValuePerDay: 25 }, 7);
    expect(r.agreed && r.warrantyDays).toBe(90);
  });

  it("the vendor's last offer is never its exact hard minimum (stop-short)", () => {
    const hard = vendorHardMin(v);
    let atMin = 0;
    for (let i = 0; i < 300; i++) {
      const r = negotiate(v, { budget: 90_000, warrantyValuePerDay: 0 }, i);
      for (const t of r.turns) if (t.side === "vendor" && t.price === hard) atMin++;
    }
    expect(atMin).toBeLessThan(15);
  });

  it("a vendor accept never asks more than the buyer offered or the vendor last said", () => {
    let checked = 0;
    for (let s = 1; s < 3000; s++) {
      const list = 12_000 + (s % 150) * 1000, floor = Math.round(list * (0.6 + (s % 30) / 100));
      const vt: VendorTerms = { list, floor, target: list, maxDiscountPct: 50, warrantyOptions: [0, 30], warrantyCostPerDay: s % 3, leadDays: 2 };
      const r = negotiate(vt, { budget: Math.round(list * (0.7 + (s % 40) / 100)), warrantyValuePerDay: s % 5 }, s);
      const acc = r.turns.at(-1);
      if (!r.agreed || acc?.side !== "vendor") continue;
      checked++;
      const before = r.turns.slice(0, -1).reverse();
      expect(acc.price).toBeLessThanOrEqual(before.find((t) => t.side === "buyer")!.price);
      expect(acc.price).toBeLessThanOrEqual(before.find((t) => t.side === "vendor")!.price);
      expect(acc.price).toBeGreaterThanOrEqual(floor);
    }
    expect(checked).toBeGreaterThan(500);
  });
});
