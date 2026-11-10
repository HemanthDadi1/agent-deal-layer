// ---- Market simulation built on the engine (engine.js must be loaded first) ----
const TICKS_PER_DAY = 144;            // 1 tick = 10 simulated minutes
const FEE_RATE = 0.035, PROTECTION_FEE = 5;

const ASSISTANTS = [
  { key: "chatgpt", name: "ChatGPT", size: "large model", skill: 0.8 },
  { key: "claude", name: "Claude", size: "large model", skill: 0.8 },
  { key: "gemini", name: "Gemini", size: "large model", skill: 0.75 },
  { key: "grok", name: "Grok", size: "mid-size model", skill: 0.6 },
  { key: "deepseek", name: "DeepSeek", size: "mid-size model", skill: 0.55 },
  { key: "small", name: "Small open model", size: "small model", skill: 0.2 },
];
const SELLER_NAMES = ["Marcus Refurb Co.", "BayTech Resale", "Campus Gadgets", "QuickFlip Electronics",
  "Northside Computers", "ReBoot Labs", "Pixel & Port", "Second Byte"];
const PRODUCT_MIX = [["macbook-air-m2-16gb", 0.55], ["dell-xps-13-16gb", 0.25], ["monitor-27-4k", 0.2]];
const BASE_COMPS = Object.fromEntries(Object.entries(SEED.products).map(([k, p]) => [k, [...p.comps]]));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function createSim(opts = {}) {
  const S = {
    seed: opts.seed ?? 7, t: 0, rate: opts.rate ?? 48, risk: opts.risk ?? 1, respectMarket: opts.respectMarket ?? true,
    sellers: [], listings: [], buyers: [], deals: [], events: [], prices: [], bands: {},
    fair: Object.fromEntries(ASSISTANTS.map(a => [a.key, { n: 0, eng: 0, alone: 0, engRatio: 0, aloneRatio: 0, noDealAlone: 0 }])),
    k: { arrived: 0, matched: 0, noMatch: 0, approved: 0, declined: 0, soldOut: 0, gmv: 0, revenue: 0, saved: 0,
         delivered: 0, released: 0, disputes: 0, rejected: 0, refunds: 0, refundSum: 0, capViolations: 0 },
    nid: { buyer: 0, listing: 0, deal: 0 },
  };
  const rnd = mulberry32(S.seed);
  const U = (a, b) => a + (b - a) * rnd();
  const RI = (a, b) => Math.floor(U(a, b + 1));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const wpick = pairs => { let x = rnd(), acc = 0; for (const [v, w] of pairs) { acc += w; if (x <= acc) return v; } return pairs.at(-1)[0]; };
  S.rnd = rnd;

  for (const [k, c] of Object.entries(BASE_COMPS)) SEED.products[k].comps = [...c];
  // "true" market value per product drifts slowly; sellers and buyers price from it,
  // while the price guidance has to learn it from closed deals.
  S.value = Object.fromEntries(Object.entries(BASE_COMPS).map(([k, c]) => [k, guidance(k).median]));

  function log(kind, text, extra = {}) {
    S.events.unshift({ t: S.t, kind, text, ...extra });
    if (S.events.length > 80) S.events.length = 80;
  }

  // ---------------------------------------------------------- sellers & listings
  function makeListing(seller, product) {
    const v = S.value[product], laptop = product !== "monitor-27-4k";
    const battery = laptop ? RI(80, 96) : undefined;
    const warranty = [{ days: 0, cpd: 0 }];
    if (rnd() < 0.6) warranty.push(rnd() < 0.5 ? { days: 30, cpd: +U(0.2, 0.4).toFixed(2) } : { days: 90, cpd: +U(0.15, 0.3).toFixed(2) });
    const delivery = [{ days: RI(2, 6), cost: 0 }];
    if (rnd() < 0.4) delivery.push({ days: RI(1, 2), cost: RI(12, 25) });
    const l = {
      id: "L" + (++S.nid.listing), seller: seller.id, toughness: seller.toughness, product,
      list: Math.round(v * U(1.03, 1.15)), floor: Math.round(v * U(0.9, 0.99)),
      specs: laptop ? { ram_gb: 16, battery_health: battery, condition: battery >= 85 ? "A" : "B" } : { condition: "A" },
      warranty, delivery, stock: RI(2, 4), sold: 0,
    };
    S.listings.push(l);
    return l;
  }
  SELLER_NAMES.forEach((name, i) => {
    const s = { id: "M" + (i + 1), name, verified: i !== 3 && i !== 6, toughness: +U(0.35, 0.75).toFixed(2),
      sales: 0, revenue: 0, margin: 0, disputes: 0, refunds: 0, released: 0 };
    S.sellers.push(s);
    const n = RI(2, 3);
    for (let j = 0; j < n; j++) makeListing(s, wpick(PRODUCT_MIX));
  });
  const sellerOf = id => S.sellers.find(s => s.id === id);
  const stockOf = s => S.listings.filter(l => l.seller === s.id).reduce((a, l) => a + l.stock, 0);

  function snapshotBands() {
    for (const [k] of PRODUCT_MIX) {
      const g = guidance(k);
      (S.bands[k] ||= []).push({ t: S.t, lo: g.fair[0], hi: g.fair[1], med: g.median });
      if (S.bands[k].length > 400) S.bands[k].shift();
    }
  }
  snapshotBands();

  // ---------------------------------------------------------- buyers
  function arrive() {
    const asst = pick(ASSISTANTS), product = wpick(PRODUCT_MIX), g = guidance(product);
    const laptop = product !== "monitor-27-4k";
    const batt = laptop ? wpick([[85, 0.5], [80, 0.25], [0, 0.25]]) : 0;
    const m = { product, maxPrice: Math.round(S.value[product] * U(0.9, 1.12)), deadline: RI(2, 8),
      warrantyValue: rnd() < 0.5 ? 0 : +U(0.3, 1.5).toFixed(2),
      minSpecs: laptop ? { ram_gb: 16, ...(batt ? { battery_health: batt } : {}) } : {},
      toughness: +U(0.3, 0.7).toFixed(2), respectMarket: S.respectMarket };
    const b = { id: ++S.nid.buyer, asst, product, m, t0: S.t, state: "negotiating", round: 0, guidance: g };
    S.k.arrived++;
    const live = S.listings.filter(l => l.product === product && l.stock > 0);
    const r = runNegotiation(m, live);
    b.contacted = r.considered.length; b.skipped = r.skipped.length;
    if (!r.best.length) {
      b.state = "nodeal"; b.done = S.t; S.k.noMatch++;
      b.reason = !live.length ? "no stock for this product" : r.considered.length ? "budget below every seller's limit" : "no listing meets the specs or deadline";
      log("nodeal", `Buyer #${b.id} (${asst.name}) found no deal: ${b.reason}`);
    } else {
      b.neg = r.best[0]; b.listing = S.listings.find(l => l.id === b.neg.listing);
      S.k.matched++;
      log("arrive", `Buyer #${b.id} (${asst.name}) negotiating with ${b.contacted} seller${b.contacted === 1 ? "" : "s"} for ${SEED.products[product].title}`);
    }
    S.buyers.unshift(b);
  }

  // what this buyer's assistant would get bargaining alone with the same listing and package
  function shadowAlone(b) {
    const g = b.guidance, l = b.listing, o = b.neg, s = b.asst.skill;
    const w = l.warranty.find(x => x.days === o.warranty), d = l.delivery.find(x => x.days === o.delivery);
    const opening = Math.round(g.opening + (1 - s) * (g.walk - g.opening));
    const alone = negotiatePackage({ ...b.m, respectMarket: false, toughness: 0.1 + 0.75 * s }, l, opening, w, d, null);
    return alone.agreed ? alone.price : null;
  }

  function approve(b) {
    const l = b.listing, o = b.neg;
    if (l.stock <= 0) {
      b.state = "soldout"; b.done = S.t; S.k.soldOut++;
      log("nodeal", `Buyer #${b.id}: ${l.id} sold out before approval`); return;
    }
    // hard-cap invariants (should never fire)
    const w = l.warranty.find(x => x.days === o.warranty), d = l.delivery.find(x => x.days === o.delivery);
    const sellerLimit = l.floor + o.warranty * w.cpd + d.cost;
    if (o.price > b.m.maxPrice + 1e-9 || o.price < sellerLimit - 1e-9) S.k.capViolations++;

    l.stock--; l.sold++;
    const seller = sellerOf(l.seller), price = o.price;
    const deal = { id: ++S.nid.deal, buyer: b, listing: l, seller, price, costs: o.warranty * w.cpd + d.cost,
      terms: { product: l.product, price, warranty_days: o.warranty, delivery_days: o.delivery, specs: l.specs },
      stage: "funded", t0: S.t, deliverAt: S.t + o.delivery * TICKS_PER_DAY };
    S.deals.push(deal);
    b.state = "approved"; b.done = S.t; b.deal = deal;
    S.k.approved++; S.k.gmv += price; S.k.revenue += FEE_RATE * price + PROTECTION_FEE; S.k.saved += Math.max(0, l.list - price);
    seller.sales++; seller.revenue += price; seller.margin += price - l.floor - deal.costs;
    const comps = SEED.products[l.product].comps; comps.push(price); if (comps.length > 30) comps.shift();
    S.prices.push({ t: S.t, product: l.product, price, asst: b.asst.key });
    if (S.prices.length > 1500) S.prices.shift();
    const alone = shadowAlone(b), med = b.guidance.median, f = S.fair[b.asst.key];
    if (alone == null) f.noDealAlone++;
    else { f.n++; f.eng += price; f.alone += alone; f.engRatio += price / med; f.aloneRatio += alone / med; }
    deal.alone = alone;
    log("deal", `Deal #${deal.id}: Buyer #${b.id} (${b.asst.name}) buys from ${seller.name} at $${price}${o.warranty ? ` with ${o.warranty}-day warranty` : ""}; $${price} held in escrow`, { price });
  }

  // ---------------------------------------------------------- escrow & disputes
  function defectProb(seller) { return (seller.verified ? 0.03 : 0.12) * S.risk; }

  function progressDeal(d) {
    if (d.stage === "funded" && S.t >= d.deliverAt) {
      d.stage = "inspecting"; S.k.delivered++;
      const bad = S.rnd() < defectProb(d.seller), falseClaim = !bad && S.rnd() < 0.01 * S.risk;
      if (bad || falseClaim) { d.disputeAt = S.t + RI(6, 2 * TICKS_PER_DAY); d.defect = bad; }
      else d.releaseAt = S.t + RI(12, 3 * TICKS_PER_DAY);
    } else if (d.stage === "inspecting" && d.releaseAt && S.t >= d.releaseAt) {
      d.stage = "released"; S.k.released++; d.seller.released += d.price;
      if (S.rnd() < 0.25) log("release", `Deal #${d.id}: buyer confirmed, $${d.price} released to ${d.seller.name}`);
    } else if (d.stage === "inspecting" && d.disputeAt && S.t >= d.disputeAt) {
      openDispute(d);
    } else if (d.stage === "review" && S.t >= d.resolveAt) {
      resolve(d, true);
    }
  }

  function openDispute(d) {
    S.k.disputes++; d.seller.disputes++;
    const laptop = d.terms.product !== "monitor-27-4k", promised = d.terms.specs.battery_health;
    let claim, ev = { photo: "evidence.jpg" }, days = Math.floor((S.t - d.deliverAt) / TICKS_PER_DAY);
    if (!d.defect) { claim = laptop ? "battery_below_promised" : "arrived_dead"; if (laptop) ev.measured_battery_health = promised - 1; else days = 4; }
    else if (laptop) {
      claim = S.rnd() < 0.7 ? "battery_below_promised" : "arrived_dead";
      if (claim === "battery_below_promised") ev.measured_battery_health = promised - RI(4, 14);
    } else claim = S.rnd() < 0.6 ? "arrived_dead" : "not_as_described";
    if (d.defect && S.rnd() < 0.08) days = 4;                      // some buyers report too late
    d.claim = claim; d.review = reviewDispute(d.terms, claim, ev, days, true, true);
    log("dispute", `Deal #${d.id}: buyer disputes (${claim.replaceAll("_", " ")}); panel recommends ${d.review.outcome.replaceAll("_", " ")}${d.review.refund ? ` $${Math.round(d.review.refund)}` : ""}`);
    if (d.review.needsHuman) { d.stage = "review"; d.resolveAt = S.t + RI(12, 60); }
    else resolve(d, false);
  }

  function resolve(d, human) {
    let refund = 0;
    const out = d.review.outcome;
    if (out === "full_refund_on_return") refund = d.price;
    else if (out === "partial_refund") refund = Math.min(d.review.refund, d.price);
    else if (out === "human_judgement") refund = Math.round(d.price * 0.15);  // reviewer's call in the sim
    d.refund = refund; d.stage = "resolved";
    if (refund > 0) { S.k.refunds++; S.k.refundSum += refund; d.seller.refunds += refund; }
    else S.k.rejected++;
    d.seller.released += d.price - refund;
    log("resolve", `Deal #${d.id} settled${human ? " by a human reviewer" : " automatically"}: ${refund ? `$${Math.round(refund)} back to buyer` : "claim rejected"}, $${Math.round(d.price - refund)} to ${d.seller.name}`);
  }

  // ---------------------------------------------------------- tick
  function tick() {
    S.t++;
    if (S.rnd() < S.rate / TICKS_PER_DAY) arrive();
    for (const b of S.buyers) {
      if (b.state === "negotiating") {
        b.round++;
        if (b.round >= b.neg.rounds.length) { b.state = "awaiting"; b.decideAt = S.t + RI(2, 8); }
      } else if (b.state === "awaiting" && S.t >= b.decideAt) {
        const pApprove = b.neg.price > 0.97 * b.m.maxPrice ? 0.75 : 0.92;
        if (S.rnd() < pApprove) approve(b);
        else { b.state = "declined"; b.done = S.t; S.k.declined++; log("decline", `Buyer #${b.id} (${b.asst.name}) declined $${b.neg.price}`); }
      }
    }
    if (S.buyers.length > 160) S.buyers.length = 160;
    for (const d of S.deals) progressDeal(d);
    if (S.t % 12 === 0) snapshotBands();
    if (S.t % (TICKS_PER_DAY / 4) === 0) {                             // restock every 6 hours
      for (const s of S.sellers) if (stockOf(s) < 4 && S.rnd() < 0.8) {
        const l = makeListing(s, wpick(PRODUCT_MIX));
        log("restock", `${s.name} listed ${SEED.products[l.product].title} at $${l.list} (floor private)`);
      }
    }
    if (S.t % TICKS_PER_DAY === 0)                                       // market value drifts
      for (const k in S.value) S.value[k] *= 1 + (S.rnd() - 0.5) * 0.012;
  }

  S.tick = tick; S.stockOf = stockOf; S.sellerOf = sellerOf;
  return S;
}

if (typeof module !== "undefined") module.exports = { createSim, ASSISTANTS, TICKS_PER_DAY };
