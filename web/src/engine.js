// ---- Agent Deal Layer engine (port of agentdeal/engine.py + ledger rules) ----
const ROUNDS = 10;
const COND = { A: 3, B: 2, C: 1 };
const HUMAN_REVIEW_ABOVE = 200, INSPECTION_DAYS = 3;

const SEED = {
  products: {
    "macbook-air-m2-16gb": { title: "MacBook Air M2 (16GB)", launch: 1399,
      comps: [640, 655, 662, 670, 678, 685, 690, 702, 710, 720],
      checklist: ["Battery cycle count and health %", "Activation Lock / Find My is off",
        "Keyboard, trackpad and screen: no dead keys or pixels", "Original charger included",
        "Serial number matches and is not reported stolen"] },
    "dell-xps-13-16gb": { title: "Dell XPS 13 (16GB)", launch: 1299,
      comps: [480, 495, 505, 515, 520, 530, 545, 560],
      checklist: ["Battery health in Dell Power Manager", "BIOS password removed",
        "Windows license activated", "Hinge and screen condition"] },
    "monitor-27-4k": { title: "27-inch 4K monitor", launch: 399,
      comps: [205, 212, 219, 225, 229, 234, 240, 249],
      checklist: ["Dead or stuck pixels", "Backlight bleed in a dark room", "Stand and cables included"] },
  },
  sellers: {
    S1: { name: "Marcus Refurb Co.", toughness: 0.6, verified: true },
    S2: { name: "BayTech Resale", toughness: 0.4, verified: true },
    S3: { name: "Campus Gadgets", toughness: 0.7, verified: true },
    S4: { name: "QuickFlip Electronics", toughness: 0.5, verified: false },
  },
  listings: [
    { id: "L1", seller: "S1", product: "macbook-air-m2-16gb", list: 749, floor: 655,
      specs: { ram_gb: 16, storage_gb: 512, battery_health: 88, condition: "A" },
      warranty: [{ days: 0, cpd: 0 }, { days: 30, cpd: 0.35 }, { days: 90, cpd: 0.3 }],
      delivery: [{ days: 5, cost: 0 }, { days: 2, cost: 15 }] },
    { id: "L2", seller: "S2", product: "macbook-air-m2-16gb", list: 729, floor: 660,
      specs: { ram_gb: 16, storage_gb: 256, battery_health: 91, condition: "A" },
      warranty: [{ days: 0, cpd: 0 }], delivery: [{ days: 3, cost: 0 }] },
    { id: "L3", seller: "S3", product: "macbook-air-m2-16gb", list: 799, floor: 690,
      specs: { ram_gb: 16, storage_gb: 512, battery_health: 95, condition: "A" },
      warranty: [{ days: 0, cpd: 0 }, { days: 60, cpd: 0.25 }],
      delivery: [{ days: 4, cost: 0 }, { days: 1, cost: 25 }] },
    { id: "L4", seller: "S4", product: "macbook-air-m2-16gb", list: 690, floor: 610,
      specs: { ram_gb: 16, storage_gb: 256, battery_health: 82, condition: "B" },
      warranty: [{ days: 0, cpd: 0 }], delivery: [{ days: 6, cost: 0 }] },
    { id: "L5", seller: "S1", product: "macbook-air-m2-16gb", list: 769, floor: 700,
      specs: { ram_gb: 16, storage_gb: 1024, battery_health: 90, condition: "A" },
      warranty: [{ days: 0, cpd: 0 }, { days: 30, cpd: 0.35 }], delivery: [{ days: 7, cost: 0 }] },
    { id: "L6", seller: "S2", product: "dell-xps-13-16gb", list: 579, floor: 505,
      specs: { ram_gb: 16, storage_gb: 512, battery_health: 86, condition: "A" },
      warranty: [{ days: 0, cpd: 0 }, { days: 30, cpd: 0.3 }], delivery: [{ days: 3, cost: 0 }] },
    { id: "L7", seller: "S1", product: "monitor-27-4k", list: 259, floor: 214,
      specs: { condition: "A" },
      warranty: [{ days: 0, cpd: 0 }, { days: 90, cpd: 0.08 }], delivery: [{ days: 5, cost: 0 }] },
  ],
};

// Python's round(): half to even, so prices match the Python POC exactly.
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
const r2 = x => Math.round(x * 100) / 100;

function pct(s, p) {
  const k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}
function median(s) {
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function guidance(productKey) {
  const p = SEED.products[productKey];
  const s = [...p.comps].sort((a, b) => a - b);
  const p25 = pct(s, 0.25), mid = median(s), p75 = pct(s, 0.75);
  return { title: p.title, launch: p.launch, deals: s.length, comps: s,
    fair: [pyRound(p25), pyRound(p75)], median: pyRound(mid),
    opening: pyRound(p25 - 0.5 * (mid - p25)), walk: pyRound(p75 + 0.5 * (p75 - p25)),
    checklist: p.checklist };
}

function matches(m, l) {
  if (l.product !== m.product) return [false, "different product"];
  for (const [k, v] of Object.entries(m.minSpecs || {}))
    if ((l.specs[k] || 0) < v) return [false, `${k.replace("_", " ")} below requirement`];
  if ((COND[l.specs.condition || "C"] || 0) < (COND[m.minCondition || "C"] || 0))
    return [false, "condition below requirement"];
  if (!l.delivery.some(d => d.days <= m.deadline)) return [false, "cannot deliver by the deadline"];
  return [true, ""];
}

const exponent = t => 0.3 + 1.7 * (1 - Math.min(Math.max(t, 0), 1));
const fraction = (k, t) => Math.pow(k / ROUNDS, 1 / exponent(t));

function negotiatePackage(m, l, opening, w, d, walk) {
  const sellerT = SEED.sellers[l.seller] ? SEED.sellers[l.seller].toughness : (l.toughness ?? 0.5);
  const sellerReserve = l.floor + w.days * w.cpd + d.cost;
  let buyerReserve = m.maxPrice;
  if (walk != null) buyerReserve = Math.min(buyerReserve, walk + 0.5 * w.days * m.warrantyValue);
  const base = { listing: l.id, seller: l.seller, warranty: w.days, delivery: d.days,
    sellerReserve, buyerReserve };
  if (sellerReserve > buyerReserve)
    return { ...base, agreed: false, price: null, rounds: [], reason: "no overlap between the two sides' limits" };
  const ask0 = Math.max(l.list + w.days * w.cpd + d.cost, sellerReserve);
  const bid0 = Math.min(opening, buyerReserve);
  const rounds = [];
  for (let k = 0; k <= ROUNDS; k++) {
    const ask = ask0 - (ask0 - sellerReserve) * fraction(k, sellerT);
    const bid = bid0 + (buyerReserve - bid0) * fraction(k, m.toughness);
    rounds.push({ k, ask: r2(ask), bid: r2(bid) });
    if (bid >= ask) {
      let price = (ask + bid) / 2;
      if (Math.ceil(sellerReserve) <= Math.floor(buyerReserve))
        price = Math.min(Math.max(pyRound(price), Math.ceil(sellerReserve)), Math.floor(buyerReserve));
      else price = r2(Math.min(Math.max(price, sellerReserve), buyerReserve));
      return { ...base, agreed: true, price, rounds, utility: r2(w.days * m.warrantyValue - price) };
    }
  }
  return { ...base, agreed: false, price: null, rounds, reason: "no agreement within 10 rounds" };
}

function negotiateListing(m, l, opening, walk) {
  let best = null;
  for (const w of l.warranty) for (const d of l.delivery) {
    if (d.days > m.deadline) continue;
    const o = negotiatePackage(m, l, opening, w, d, walk);
    if (!o.agreed) { if (!best) best = o; continue; }
    if (!best || !best.agreed || o.utility > best.utility ||
        (o.utility === best.utility && (o.price < best.price ||
          (o.price === best.price && o.delivery < best.delivery)))) best = o;
  }
  return best;
}

function runNegotiation(m, listings = SEED.listings) {
  const g = guidance(m.product);
  const walk = m.respectMarket ? g.walk : null;
  const considered = [], skipped = [];
  for (const l of [...listings].sort((a, b) => a.id.localeCompare(b.id))) {
    const [ok, why] = matches(m, l);
    if (!ok) { if (l.product === m.product) skipped.push({ listing: l.id, reason: why }); continue; }
    considered.push(negotiateListing(m, l, g.opening, walk));
  }
  const best = considered.filter(o => o.agreed)
    .sort((a, b) => b.utility - a.utility || a.price - b.price || a.listing.localeCompare(b.listing));
  return { guidance: g, considered, best: best.slice(0, 3), skipped,
    noDeal: considered.filter(o => !o.agreed) };
}

// ---- dispute panel (port of ledger.review_dispute) ----
function ruleFor(claim, terms, ev) {
  const price = terms.price;
  if (claim === "arrived_dead") return { outcome: "full_refund_on_return", refund: price };
  if (claim === "battery_below_promised") {
    const promised = terms.specs.battery_health, measured = ev.measured_battery_health;
    if (promised == null || measured == null) return { outcome: "need_more_evidence", refund: 0 };
    const gap = promised - measured;
    if (gap <= 2) return { outcome: "reject_claim", refund: 0 };
    return { outcome: "partial_refund", refund: Math.min(price, 5 * gap) };
  }
  if (claim === "not_as_described") return { outcome: "human_judgement", refund: 0 };
  return { outcome: "unknown_claim", refund: 0 };
}

function reviewDispute(terms, claim, ev, days, recordOk, presentedMatches) {
  const integrity = !recordOk
    ? { reviewer: "Integrity", vote: "escalate", why: "stored record failed verification" }
    : !presentedMatches
      ? { reviewer: "Integrity", vote: "reject_claim", why: "record shown by the claimant does not match the signed record" }
      : { reviewer: "Integrity", vote: "ok", why: "signed record verified" };
  const rr = ruleFor(claim, terms, ev);
  const rules = { reviewer: "Rules", vote: rr.outcome, refund: rr.refund, why: "applied the fixed rule table" };
  let evidence;
  if (days > INSPECTION_DAYS) evidence = { reviewer: "Evidence", vote: "reject_claim", why: "opened after the 3-day inspection window" };
  else if (!Object.keys(ev).length) evidence = { reviewer: "Evidence", vote: "need_more_evidence", why: "no evidence attached" };
  else evidence = { reviewer: "Evidence", vote: rr.outcome, refund: rr.refund, why: "evidence present and inside the inspection window" };
  const votes = [integrity, rules, evidence];
  let outcome, refund, unanimous;
  if (integrity.vote !== "ok") { outcome = integrity.vote; refund = 0; unanimous = true; }
  else {
    outcome = rules.vote; refund = rules.refund || 0; unanimous = rules.vote === evidence.vote;
    if (!unanimous && ["reject_claim", "need_more_evidence"].includes(evidence.vote)) { outcome = evidence.vote; refund = 0; }
  }
  const needsHuman = !unanimous || terms.price > HUMAN_REVIEW_ABOVE || ["human_judgement", "escalate"].includes(outcome);
  return { votes, outcome, refund, needsHuman };
}

if (typeof module !== "undefined") module.exports = { SEED, guidance, runNegotiation, negotiatePackage, reviewDispute, pyRound };
