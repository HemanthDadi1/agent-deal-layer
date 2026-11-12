/**
 * hearth.ts: the Hearth connector (https://github.com/HemanthDadi1/hearth, CONNECTOR.md) on top of this layer.
 *
 * Hearth is the people-facing shell; this file turns its routes into the layer's real flow:
 *   seller listing  -> an approved vendor + one item with a floor (the seller's private lowest price)
 *   buyer intent    -> a mandate with a budget (the buyer's private most); the shared engine negotiates
 *   seller "Confirm" -> vendorDecision;  buyer "Approve" -> approveQuote with the PIN -> escrow hold
 *   watch / wanted board / invites -> re-run matching for one new item against a waiting mandate
 *
 * Privacy: nothing sent back to the shell carries a floor or a budget, only offers and agreed prices.
 *
 * shortcut: Hearth has no login yet, so every Hearth buyer is one shared demo client whose PIN is
 *   printed at start-up (HEARTH_PIN to choose it). Add Hearth accounts before real users.
 * shortcut: the layer prices in USD cents ($100 to $2,000); the bridge converts INR at HEARTH_INR_PER_USD
 *   (default 83). A real deployment needs the layer to price in INR.
 * shortcut: bridge state (which Hearth id is which mandate or item, event logs, invites) is in memory;
 *   `npm run hearth` uses an in-memory database too, so the two always match. Persist both together later.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Platform } from "./service.js";
import { HttpError } from "./service.js";

type Row = Record<string, any>;
type Ev = Record<string, any> & { type: string };
type Buyer = { id: string; mandateId: string; payload: Row; watching: boolean; posted: boolean; watchSince: number | null; createdAt: number };
type Seller = { id: string; vendorId: string; itemId: string; payload: Row; first: string; autoAt: number | null; createdAt: number };
type Invite = { token: string; buyer: string; link: string | null; seenPrice: number | null; sellerName: string | null; status: string; createdAt: number; seller?: string };

const BUYER = "hearth.buyer-intent/1", SELLER = "hearth.seller-listing/1";
const COND: Record<string, string> = { new: "new", like_new: "like new", good: "used", fair: "fair", parts: "for parts" };
const DEADLINE: Record<string, number | null> = { asap: 2, this_week: 7, this_month: 30, no_rush: null };
const INVITE_TTL = 48 * 3600_000;

const bad = (m: string) => new HttpError(422, m);
const posInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9;
const str = (v: unknown, max = 500) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** The same rules as the shell's connector.js validate(); the layer never trusts the browser. */
export function validateHearth(p: Row): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["payload must be an object"];
  if (![BUYER, SELLER].includes(p.schema)) errs.push("unknown schema");
  if (!str(p.id, 64) || !/^[\w-]+$/.test(p.id)) errs.push("id is required");
  if (p.currency !== "INR") errs.push("currency must be INR");
  const pub = p.public ?? {}, priv = p.private ?? {};
  if (p.schema === BUYER) {
    if (!str(pub.want)) errs.push("public.want is required");
    if (!posInt(priv.maxPrice)) errs.push("private.maxPrice must be a positive whole number");
    if (priv.hopingFor != null && !(posInt(priv.hopingFor) && priv.hopingFor <= priv.maxPrice)) errs.push("private.hopingFor must not exceed maxPrice");
  }
  if (p.schema === SELLER) {
    if (!str(pub.title, 120)) errs.push("public.title is required");
    if (!posInt(pub.askingPrice)) errs.push("public.askingPrice must be a positive whole number");
    if (!posInt(priv.lowestPrice)) errs.push("private.lowestPrice must be a positive whole number");
    if (posInt(pub.askingPrice) && posInt(priv.lowestPrice) && priv.lowestPrice > pub.askingPrice) errs.push("private.lowestPrice must not exceed public.askingPrice");
    if (priv.autoConfirmAbove != null && !(posInt(priv.autoConfirmAbove) && priv.autoConfirmAbove >= priv.lowestPrice)) errs.push("private.autoConfirmAbove must be at least lowestPrice");
  }
  return errs;
}

export interface HearthOptions { pin?: string; inrPerUsd?: number; origins?: string[] }

export function registerHearth(app: FastifyInstance, p: Platform, o: HearthOptions = {}) {
  const rate = o.inrPerUsd ?? 83;
  const origins = new Set(o.origins ?? ["http://127.0.0.1:8090", "http://localhost:8090"]);
  // Rupees <-> cents. Buyer limits round down and seller limits round up, so converting back never crosses a limit.
  const capCents = (inr: number) => Math.floor((inr * 100) / rate);
  const floorCents = (inr: number) => Math.ceil((inr * 100) / rate);
  const inr = (cents: number) => Math.round((cents * rate) / 100);
  const minInr = Math.ceil(100 * rate), maxInr = Math.floor(2000 * rate);
  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  const buyers = new Map<string, Buyer>(), sellers = new Map<string, Seller>(), invites = new Map<string, Invite>();
  const logs = new Map<string, { events: Ev[]; keys: Set<string> }>();
  const get = (sql: string, ...a: any[]) => p.db.prepare(sql).get(...a) as Row | undefined;
  const all = (sql: string, ...a: any[]) => p.db.prepare(sql).all(...a) as Row[];

  // ---------- the shared demo buyer ----------
  const pin = o.pin ?? String(1000 + (randomBytes(2).readUInt16BE() % 9000));
  const client = p.signupClient({ name: "Hearth buyers (demo)", email: `hearth-${randomBytes(4).toString("hex")}@hearth.local`, pin });

  // ---------- sellers become vendors with one item ----------
  function addSeller(payload: Row, first: string, autoAt: number | null) {
    const pub = payload.public, priv = payload.private;
    if (pub.askingPrice < minInr || pub.askingPrice > maxInr) throw bad(`This layer handles ${fmt(minInr)} to ${fmt(maxInr)} for now.`);
    const code = p.createAccessCode();
    // shortcut: peer sellers have no business ID; the layer's vendor flow needs one, so the bridge uses a placeholder.
    const v = p.signupVendor({ name: first ? `${first} (Hearth)` : "A Hearth seller", email: `${payload.id}@hearth.local`, businessId: "00-0000000", accessCode: code });
    p.decideVendor(v.vendorId, true, "Hearth seller");
    p.updateVendorSettings(v.vendorId, { confirmChannel: "dashboard" });
    const list = Math.max(floorCents(pub.askingPrice), floorCents(priv.lowestPrice));
    const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const cat = pub.category && pub.category !== "other" ? pub.category : "other";
    const csv = `title,category,price,stock,specs,condition\n${q(pub.title)},${cat},${(list / 100).toFixed(2)},1,${q((pub.details ?? []).join(" "))},${q(COND[pub.condition] ?? "used")}\n`;
    const r = p.importCsv(v.vendorId, csv);
    if (!r.itemIds.length) throw bad(r.errors[0]?.error ?? "listing was not accepted");
    const itemId = r.itemIds[0], floor = Math.min(floorCents(priv.lowestPrice), list);
    const wd = [30, 90].includes(pub.warrantyDays) ? pub.warrantyDays : 0;
    p.setItemRules(v.vendorId, itemId, {
      floor, target: Math.max(floor, Math.round(list * 0.95)), maxDiscountPct: Math.min(100, Math.ceil(100 * (1 - floor / list)) + 1),
      warrantyOptions: wd ? [0, wd] : [0], warrantyCostPerDay: 0,
    });
    const s: Seller = { id: payload.id, vendorId: v.vendorId, itemId, payload, first, autoAt: autoAt == null ? null : floorCents(autoAt), createdAt: Date.now() };
    sellers.set(s.id, s);
    return s;
  }
  // The seller's own rule: confirm on their behalf at or above autoConfirmAbove (the layer's own rule is the inverse).
  function autoConfirm() {
    for (const s of sellers.values()) {
      if (s.autoAt == null) continue;
      for (const q of all("SELECT id, price FROM quotes WHERE item_id=? AND status='awaiting_vendor'", s.itemId))
        if (q.price >= s.autoAt) p.vendorDecision(s.vendorId, q.id, true);
    }
  }
  const dealFor = (mandateId: string) => get("SELECT d.* FROM deals d JOIN quotes q ON q.id=d.quote_id WHERE q.mandate_id=?", mandateId);
  function matchWaiting(s: Seller) {
    for (const b of buyers.values()) {
      if (!b.watching || dealFor(b.mandateId)) continue;
      p.runMatching(b.mandateId, s.itemId);
      if (get("SELECT 1 FROM quotes WHERE mandate_id=? AND item_id=? AND status!='lost'", b.mandateId, s.itemId)) { b.watching = false; }
    }
    autoConfirm();
  }

  // ---------- public views (never a floor or a budget) ----------
  function product(itemId: string): Row {
    const it = get(`SELECT i.*, r.warranty_options, v.name vname, v.id vid FROM items i JOIN item_rules r ON r.item_id=i.id JOIN vendors v ON v.id=i.vendor_id WHERE i.id=?`, itemId)!;
    const s = [...sellers.values()].find((x) => x.itemId === itemId);
    const t = p.trust(it.vid);
    const first = s?.first || it.vname.replace(/ \(Hearth\)$|'s .*$/, "").split(" ")[0] || "The seller";
    return {
      id: it.id, title: it.title, category: it.category, condition: it.condition[0].toUpperCase() + it.condition.slice(1),
      price: s ? s.payload.public.askingPrice : inr(it.list_price), warrantyDays: Math.max(...JSON.parse(it.warranty_options)),
      details: JSON.parse(it.specs), description: s?.payload.public.description ?? "",
      sellerInfo: { name: it.vname, first, city: s?.payload.public.handover?.city ?? "", rating: t.verified ? "Verified" : "New", deals: t.completedDeals, onTime: t.onTimeRate ?? 100, since: "2026", color: "#a0663c" },
    };
  }
  const say = (side: string, kind: string, priceInr: number, first: string, title: string) =>
    side === "vendor" && kind === "offer" ? `Hi! ${first}'s agent for the ${title}. Asking ${fmt(priceInr)}.`
      : side === "buyer" ? `I can do ${fmt(priceInr)}.`
        : side === "mediator" ? `A neutral mediator picked ${fmt(priceInr)}, inside both private ranges.`
          : kind === "accept" ? `${fmt(priceInr)} works. Deal if your person approves.` : `Best I can do right now is ${fmt(priceInr)}.`;
  // The opening turn is the asking price; show the seller's own rupee figure, not a round trip through dollars.
  const shown = (t: Row, prod: Row) => (t.side === "vendor" && t.kind === "offer" && t.seq === 0 ? prod.price : inr(t.price));
  const NO_DEAL: Record<string, string> = {
    price: "Too far apart. Your agent walked away politely; no limits were shared.", no_overlap: "Too far apart. No limits were shared.",
    delivery: "They can't hand it over in time.", vendor_declined: "The seller said no.", no_reply: "The seller didn't confirm in time.",
    buyer_no_action: "The offer expired.", buyer_declined: "You declined it.", buyer_chose_other: "You chose another offer.",
  };
  function dealEv(d: Row, role: "buyer" | "seller", offerId: string, product?: Row): Ev {
    const text = role === "buyer"
      ? `${fmt(inr(d.price))} is held in escrow. ${product?.sellerInfo.first ?? "The seller"} hands over the ${product?.title ?? "item"}; you release the money when it arrives as described.`
      : `The buyer's ${fmt(inr(d.price))} is held in escrow. Hand it over and you're paid once they confirm, or automatically after 3 days.`;
    return { type: "deal", deal: { id: d.id, offer: offerId, price: inr(d.price), status: "held", text } };
  }

  // ---------- event logs: recomputed from the layer, appended in order, never reordered ----------
  function sync(id: string, want: [string, Ev][]) {
    const log = logs.get(id) ?? { events: [], keys: new Set<string>() };
    logs.set(id, log);
    for (const [k, e] of want) if (!log.keys.has(k)) { log.keys.add(k); log.events.push({ ...e, seq: log.events.length + 1 }); }
    return log;
  }
  const push = (id: string, k: string, e: Ev) => sync(id, [[k, e]]);

  function buyerEvents(b: Buyer) {
    p.tick();
    const out: [string, Ev][] = [["start", { type: "status", text: "Looking through every listing on the agent layer…" }]];
    const quotes = all("SELECT q.*, i.title FROM quotes q JOIN items i ON i.id=q.item_id WHERE q.mandate_id=? ORDER BY q.rowid", b.mandateId);
    for (const q of quotes) {
      const prod = product(q.item_id), thread = `t_${q.id}`;
      out.push([`match:${q.id}`, { type: "match", product: prod }], [`thread:${q.id}`, { type: "thread", thread, product: prod }]);
      for (const t of all("SELECT * FROM negotiation_turns WHERE quote_id=? ORDER BY seq", q.id))
        out.push([`msg:${q.id}:${t.seq}`, { type: "message", thread, from: t.side === "buyer" ? "mine" : "theirs", who: t.side === "buyer" ? "Your agent" : t.side === "mediator" ? "Mediator" : `${prod.sellerInfo.first}'s agent`, text: say(t.side, t.kind, shown(t, prod), prod.sellerInfo.first, prod.title) }]);
      if (q.status === "awaiting_vendor") out.push([`wait:${q.id}`, { type: "status", text: `Agreed ${fmt(inr(q.price))} with ${prod.sellerInfo.first}'s agent. Waiting for the seller to confirm.` }]);
      if (["vendor_confirmed", "client_approved"].includes(q.status)) {
        const saved = Math.max(0, prod.price - inr(q.price));
        out.push([`offer:${q.id}`, { type: "offer", offer: { id: q.id, role: "buyer", thread, product: prod, price: inr(q.price), warrantyDays: q.warranty_days, saved, note: saved ? `${fmt(saved)} below asking${q.warranty_days ? `, with a ${q.warranty_days}-day warranty` : ""}. Confirmed by the seller.` : "At the asking price. Confirmed by the seller." } }]);
      }
      if (q.reason && NO_DEAL[q.reason] && !["vendor_confirmed", "client_approved"].includes(q.status)) out.push([`end:${q.id}`, { type: "no_deal", thread, text: NO_DEAL[q.reason] }]);
    }
    const agreed = quotes.some((q) => ["awaiting_vendor", "vendor_confirmed", "client_approved"].includes(q.status));
    const ready = quotes.filter((q) => ["vendor_confirmed", "client_approved"].includes(q.status)).length;
    if (ready) out.push([`ready:${ready}`, { type: "status", text: ready === 1 ? "Here's the deal. Approve it with your PIN and the money is held in escrow." : `Here are ${ready} offers. Approve one with your PIN.` }]);
    if (!agreed) out.push(["nomatch", { type: "no_match", text: quotes.length ? "None of them came close enough to your price. Want me to look further?" : "Nothing on the layer fits that yet. Want me to look further?", options: ["watch", "post", "invite"] }]);
    const d = dealFor(b.mandateId);
    if (d) { const q = quotes.find((x) => x.id === d.quote_id)!; out.push([`deal:${d.id}`, dealEv(d, "buyer", q.id, product(q.item_id))]); }
    return sync(b.id, out);
  }
  function sellerEvents(s: Seller) {
    p.tick();
    const out: [string, Ev][] = [["start", { type: "status", text: "Your listing is live on the agent layer. Offering it to buyers' agents." }]];
    const prod = product(s.itemId);
    for (const q of all("SELECT * FROM quotes WHERE item_id=? ORDER BY rowid", s.itemId)) {
      const thread = `t_${q.id}`, label = [...buyers.values()].find((b) => b.mandateId === q.mandate_id)?.payload.public.handover?.city;
      out.push([`thread:${q.id}`, { type: "thread", thread, buyer: label ? `A buyer's agent in ${label}` : "A buyer's agent" }]);
      for (const t of all("SELECT * FROM negotiation_turns WHERE quote_id=? ORDER BY seq", q.id))
        out.push([`msg:${q.id}:${t.seq}`, { type: "message", thread, from: t.side === "vendor" ? "mine" : "theirs", who: t.side === "vendor" ? "Your agent" : t.side === "mediator" ? "Mediator" : "Buyer's agent", text: say(t.side, t.kind, shown(t, prod), prod.sellerInfo.first, prod.title) }]);
      if (["awaiting_vendor", "vendor_confirmed", "client_approved"].includes(q.status)) {
        const confirmed = q.status !== "awaiting_vendor";
        out.push([`offer:${q.id}`, { type: "offer", offer: { id: `s_${q.id}`, role: "seller", thread, title: prod.title, price: inr(q.price), buyer: "A buyer on Hearth", approved: confirmed, note: "Agreed with the buyer's agent. Confirm, then they approve and pay into escrow." } }]);
        if (confirmed) out.push([`approved:${q.id}`, { type: "approved", offerId: `s_${q.id}` }]);
      }
      if (q.reason && NO_DEAL[q.reason] && !["vendor_confirmed", "client_approved"].includes(q.status)) out.push([`end:${q.id}`, { type: "no_deal", thread, text: q.reason === "price" ? "That buyer couldn't meet your price. Nothing private was shared." : NO_DEAL[q.reason] }]);
      const d = get("SELECT * FROM deals WHERE quote_id=?", q.id);
      if (d) out.push([`deal:${d.id}`, dealEv(d, "seller", `s_${q.id}`)]);
    }
    return sync(s.id, out);
  }
  const live = (i: Invite) => i.status === "open" && Date.now() - i.createdAt < INVITE_TTL;
  function isOpen(id: string) {
    const b = buyers.get(id);
    if (b) {
      if (dealFor(b.mandateId)) return false;
      return b.watching || [...invites.values()].some((i) => i.buyer === id && live(i))
        || !!get("SELECT 1 FROM quotes WHERE mandate_id=? AND status='awaiting_vendor'", b.mandateId);
    }
    const s = sellers.get(id)!;
    return !get("SELECT 1 FROM deals WHERE item_id=?", s.itemId); // a live listing keeps listening for buyers
  }
  function publicInvite(i: Invite) {
    const b = buyers.get(i.buyer)!, pub = b.payload.public;
    const status = i.status === "open" && !live(i) ? "expired" : i.status === "open" && dealFor(b.mandateId) ? "closed" : i.status;
    return { token: i.token, status, want: pub.want, category: pub.category ?? "other", city: pub.handover?.city ?? "", timing: pub.timing ?? null, link: i.link, seenPrice: i.seenPrice, sellerName: i.sellerName, createdAt: i.createdAt };
  }
  const buyerOf = (id: string) => { const b = buyers.get(id); if (!b) throw new HttpError(404, "unknown buying agent"); return b; };

  // ---------- routes ----------
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/hearth/")) return;
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "origin")
        .header("access-control-allow-methods", "GET, POST, OPTIONS").header("access-control-allow-headers", "content-type");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? req.body : {}) as Row;

  app.get("/hearth/health", async () => ({ name: "agent-deal-layer", escrow: p.escrow.name }));
  app.get("/hearth/recommendations", async () => {
    const items = all("SELECT id FROM items WHERE status='live' AND stock>0 ORDER BY created_at DESC LIMIT 6").map((r) => product(r.id));
    return { items: items.map((it, i) => ({ ...it, why: ["Fresh on the layer", "Verified seller", "Fair price", "Popular this week", "Warranty possible", "Good condition"][i] })) };
  });
  app.get("/hearth/feed", async () => {
    const ev = [
      ...all("SELECT d.created_at at, d.price, i.title FROM deals d JOIN items i ON i.id=d.item_id ORDER BY d.created_at DESC LIMIT 4").map((r) => ({ at: r.at, text: `A deal closed at ${fmt(inr(r.price))} for the ${r.title}` })),
      ...all("SELECT i.created_at at, i.title, v.name FROM items i JOIN vendors v ON v.id=i.vendor_id ORDER BY i.created_at DESC LIMIT 4").map((r) => ({ at: r.at, text: `${r.name} listed the ${r.title}` })),
    ].sort((a, b) => b.at - a.at).slice(0, 6);
    return { events: ev };
  });

  app.post("/hearth/buyer-intents", async (req, reply) => {
    const pl = body(req), errs = validateHearth(pl);
    if (pl.schema !== BUYER) errs.push(`schema must be ${BUYER}`);
    if (errs.length) throw bad(errs.join("; "));
    if (buyers.has(pl.id)) throw new HttpError(409, "this brief was already sent");
    const priv = pl.private, pub = pl.public;
    if (priv.maxPrice < minInr || priv.maxPrice > maxInr) throw bad(`This layer handles ${fmt(minInr)} to ${fmt(maxInr)} for now.`);
    const { mandateId } = await p.createMandate(client.clientId, {
      query: pub.want, category: pub.category && pub.category !== "other" ? pub.category : undefined, mustHaves: pub.mustHaves ?? [],
      budget: capCents(priv.maxPrice), deadlineDays: DEADLINE[pub.timing] ?? undefined, warrantyValuePerDay: Math.round(((priv.warrantyValuePerDay ?? 0) * 100) / rate),
      // "Let my agent get it" on a product page: that seller only.
      onlyItemId: pub.targetProductId && get("SELECT 1 FROM items WHERE id=?", pub.targetProductId) ? pub.targetProductId : undefined,
    });
    buyers.set(pl.id, { id: pl.id, mandateId, payload: pl, watching: false, posted: false, watchSince: null, createdAt: Date.now() });
    autoConfirm();
    reply.code(201); return { id: pl.id, message: "Your agent has the brief and is negotiating on the agent layer." };
  });
  app.post("/hearth/seller-listings", async (req, reply) => {
    const pl = body(req), errs = validateHearth(pl);
    if (pl.schema !== SELLER) errs.push(`schema must be ${SELLER}`);
    if (errs.length) throw bad(errs.join("; "));
    if (sellers.has(pl.id)) throw new HttpError(409, "this listing was already sent");
    const s = addSeller(pl, "", pl.private.autoConfirmAbove ?? null);
    matchWaiting(s);
    reply.code(201); return { id: s.id, message: "Your listing is live on the agent layer." };
  });
  app.get("/hearth/agents/:id/events", async (req) => {
    const id = (req.params as Row).id, after = Number((req.query as Row).after ?? 0) || 0;
    const b = buyers.get(id), s = sellers.get(id);
    if (!b && !s) throw new HttpError(404, "unknown agent");
    const log = b ? buyerEvents(b) : sellerEvents(s!);
    return { events: log.events.filter((e) => e.seq > after), done: !isOpen(id) };
  });
  app.post("/hearth/offers/:id/approve", async (req) => {
    const id = String((req.params as Row).id);
    if (id.startsWith("s_")) {
      const q = get("SELECT * FROM quotes WHERE id=?", id.slice(2));
      if (!q) throw new HttpError(404, "This offer has expired.");
      const s = [...sellers.values()].find((x) => x.itemId === q.item_id);
      if (!s) throw new HttpError(404, "This offer has expired.");
      p.vendorDecision(s.vendorId, q.id, true);
      return { waiting: true, message: "Confirmed. Waiting for the buyer to approve and pay." };
    }
    const q = get("SELECT * FROM quotes WHERE id=?", id);
    if (!q || ![...buyers.values()].some((b) => b.mandateId === q.mandate_id)) throw new HttpError(404, "This offer has expired.");
    const pinIn = String(body(req).pin ?? "");
    if (!/^\d{4,8}$/.test(pinIn)) throw bad("Use your 4 to 8 digit PIN.");
    const r = await p.approveQuote(id, pinIn);
    const d = get("SELECT * FROM deals WHERE id=?", r.dealId)!;
    return { deal: dealEv(d, "buyer", id, product(q.item_id)).deal };
  });

  // ---------- looking further ----------
  app.post("/hearth/agents/:id/watch", async (req) => {
    const b = buyerOf((req.params as Row).id);
    if (dealFor(b.mandateId)) throw bad("This agent already closed a deal.");
    b.watching = true; b.watchSince ??= Date.now(); b.posted = b.posted || !!body(req).post;
    const text = b.posted ? "On the wanted board and watching. When a seller lists one, I'll negotiate right away."
      : "Watching. When something that fits is listed, I'll negotiate and tell you.";
    push(b.id, `watch:${b.posted}`, { type: "watching", posted: b.posted, text });
    return { message: text };
  });
  app.get("/hearth/wanted", async () => ({
    items: [...buyers.values()].filter((b) => b.posted && b.watching && !dealFor(b.mandateId))
      .map((b) => ({ id: b.id, want: b.payload.public.want, category: b.payload.public.category ?? "other", city: b.payload.public.handover?.city ?? "", timing: b.payload.public.timing ?? null, at: b.watchSince }))
      .sort((x, y) => (y.at ?? 0) - (x.at ?? 0)),
  }));
  app.post("/hearth/agents/:id/invites", async (req, reply) => {
    const b = buyerOf((req.params as Row).id), x = body(req);
    if (x.link != null && !(typeof x.link === "string" && /^https?:\/\/\S+$/.test(x.link) && x.link.length <= 500)) throw bad("link must be an http(s) address");
    if (x.seenPrice != null && !posInt(x.seenPrice)) throw bad("seenPrice must be a positive whole number");
    if (x.sellerName != null && !str(x.sellerName, 40)) throw bad("sellerName must be 1 to 40 characters");
    if (dealFor(b.mandateId)) throw bad("This agent already closed a deal.");
    if ([...invites.values()].filter((i) => i.buyer === b.id).length >= 3) throw new HttpError(429, "Your agent sends at most 3 invites per request, so it never feels like spam.");
    const token = randomBytes(12).toString("base64url");
    const inv: Invite = { token, buyer: b.id, link: x.link ?? null, seenPrice: x.seenPrice ?? null, sellerName: x.sellerName?.trim() || null, status: "open", createdAt: Date.now() };
    invites.set(token, inv);
    const origin = origins.has(String(req.headers.origin)) ? String(req.headers.origin) : [...origins][0];
    const url = `${origin}/#/invite/${token}`, w = b.payload.public.want;
    // Drafted by the agent, sent by the person; it names the AI and never carries the buyer's limit.
    const message = `Hi${inv.sellerName ? ` ${inv.sellerName}` : ""}! I saw your ${w}${inv.link ? " listed online" : ""}${inv.seenPrice ? ` for ${fmt(inv.seenPrice)}` : ""} and I'm interested. `
      + `My AI agent on Hearth can agree a price with you: you set your own price, nothing is final until you say yes, and the payment is held in escrow until handover. Have a look here: ${url}`;
    const pubInv = { ...publicInvite(inv), url, message };
    push(b.id, `invite:${token}`, { type: "invite", invite: pubInv });
    reply.code(201); return { invite: pubInv };
  });
  const inviteOf = (t: string) => { const i = invites.get(t); if (!i) throw new HttpError(404, "This invite link isn't valid."); return i; };
  app.get("/hearth/invites/:token", async (req) => ({ invite: publicInvite(inviteOf((req.params as Row).token)) }));
  app.post("/hearth/invites/:token/accept", async (req, reply) => {
    const i = inviteOf((req.params as Row).token), x = body(req), st = publicInvite(i).status;
    if (st !== "open") throw new HttpError(409, { accepted: "This invite was already accepted.", declined: "This invite was declined.", expired: "This invite has expired.", closed: "The buyer already found one. Thanks anyway!" }[st] ?? "This invite is closed.");
    const listing = x.listing ?? {}, errs = validateHearth(listing);
    if (listing.schema !== SELLER) errs.push(`listing must be a ${SELLER}`);
    if (errs.length) throw bad(errs.join("; "));
    if (sellers.has(listing.id)) throw new HttpError(409, "this listing was already sent");
    const name = str(x.name, 40) ? String(x.name).trim() : i.sellerName ?? "";
    // Ticking consent on the invite page = the seller's agent may agree at or above their lowest.
    const s = addSeller(listing, name, listing.private.lowestPrice);
    i.status = "accepted"; i.seller = s.id;
    push(i.buyer, `inviteupd:${i.token}:accepted`, { type: "invite_update", token: i.token, status: "accepted" });
    const b = buyers.get(i.buyer)!;
    if (!dealFor(b.mandateId)) p.runMatching(b.mandateId, s.itemId);
    autoConfirm();
    reply.code(201); return { id: s.id, message: "Your agent is talking to the buyer's agent." };
  });
  app.post("/hearth/invites/:token/decline", async (req) => {
    const i = inviteOf((req.params as Row).token);
    if (i.status !== "open") throw new HttpError(409, "This invite is already closed.");
    i.status = "declined";
    sync(i.buyer, [[`inviteupd:${i.token}:declined`, { type: "invite_update", token: i.token, status: "declined" }],
      [`declined:${i.token}`, { type: "status", text: `${i.sellerName ?? "The seller"} isn't selling. I won't contact them again.` }]]);
    return { message: "Thanks for letting them know. Nobody will contact you about this again." };
  });

  return { pin, inrPerUsd: rate, addSeller };
}

/** A few sellers and items so the shell has something to show (`npm run hearth`). Prices in INR. */
export function seedHearth(h: ReturnType<typeof registerHearth>) {
  const items: [string, string, string, string, number, number, number][] = [
    ["Ravi", "MacBook Air M2 16GB 512GB", "laptop", "like_new", 82000, 70000, 90],
    ["Maya", "ThinkPad T14 Gen 3 16GB", "laptop", "good", 39500, 33500, 30],
    ["Anaya", "Canon AE-1 Program 50mm film camera", "camera", "good", 16000, 13450, 30],
    ["Anu", "Olympus OM-1 50mm film camera", "camera", "like_new", 18500, 15550, 0],
    ["Kabir", "Btwin Triban RC120 road bike 54cm", "bike", "good", 26000, 21850, 30],
    ["Zoya", "Teak reading armchair", "furniture", "like_new", 21000, 17650, 0],
    ["Anaya", "Sony WH-1000XM4 headphones", "audio", "like_new", 15500, 13000, 90],
    ["Ravi", "iPhone 13 128GB", "phone", "good", 36000, 30250, 30],
  ];
  items.forEach(([first, title, category, condition, asking, lowest, warrantyDays], k) => {
    const id = `sl_seed${k}`;
    // Simulated shop sellers confirm on their own once their agent agrees, like the shell's simulated layer.
    h.addSeller({ schema: SELLER, id, currency: "INR", public: { title, description: title, category, condition, details: [], askingPrice: asking, warrantyDays, handover: { mode: "either", city: "" } },
      private: { lowestPrice: lowest, autoConfirmAbove: lowest, style: 50 } }, first, lowest);
  });
}
