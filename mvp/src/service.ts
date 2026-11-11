import type { DB } from "./db.js";
import { negotiate, vendorHardMin, type VendorTerms, type BuyerTerms, MandateViolation } from "./engine.js";
import { screen } from "./safety.js";
import type { EscrowProvider } from "./escrow.js";
import {
  sha256, newId, newSecret, hashPin, checkPin, encrypt, decrypt, seedFrom, HOUR, DAY,
} from "./util.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string) => new HttpError(400, m);
const notFound = (m: string) => new HttpError(404, m);
const forbidden = (m: string) => new HttpError(403, m);

export const VENDOR_CONFIRM_WINDOW = 2 * HOUR;
export const CLIENT_APPROVAL_WINDOW = 24 * HOUR;
export const AUTO_RELEASE = 3 * DAY;
export const DISPUTE_WINDOW = 3 * DAY;

type Row = Record<string, any>;

export interface Options {
  escrow: EscrowProvider;
  now?: () => number;
  contextKey?: string; // 32-byte hex
  baseUrl?: string;
  sendWebhook?: (url: string, payload: unknown) => Promise<void>;
}

export class Platform {
  readonly now: () => number;
  private key: string;
  baseUrl: string;
  constructor(public db: DB, private o: Options) {
    this.now = o.now ?? Date.now;
    this.key = o.contextKey ?? sha256("dev-only-context-key");
    this.baseUrl = o.baseUrl ?? "http://localhost:3000";
  }
  get escrow() { return this.o.escrow; }

  // ---------- small helpers ----------
  private get<T = Row>(sql: string, ...p: any[]): T | undefined { return this.db.prepare(sql).get(...p) as T | undefined; }
  private all<T = Row>(sql: string, ...p: any[]): T[] { return this.db.prepare(sql).all(...p) as T[]; }
  private run(sql: string, ...p: any[]) { return this.db.prepare(sql).run(...p); }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  audit(actor: string, event: string, ref = "", detail: unknown = {}) {
    this.run("INSERT INTO audit_log(actor,event,ref,detail,created_at) VALUES(?,?,?,?,?)",
      actor, event, ref, JSON.stringify(detail), this.now());
  }
  private logDecision(userType: "vendor" | "client", userId: string, ref: string, event: string, price: number | null, detail: unknown = {}) {
    this.run("INSERT INTO decision_log(user_type,user_id,ref,event,price,detail,created_at) VALUES(?,?,?,?,?,?,?)",
      userType, userId, ref, event, price, JSON.stringify(detail), this.now());
  }
  private notify(channel: "email" | "sms", to: string, subject: string, body: string) {
    this.run("INSERT INTO outbox(channel,to_addr,subject,body,created_at) VALUES(?,?,?,?,?)", channel, to, subject, body, this.now());
  }
  private async webhook(clientId: string, event: string, data: unknown) {
    const c = this.get("SELECT webhook_url FROM clients WHERE id=?", clientId);
    if (c?.webhook_url && this.o.sendWebhook) {
      try { await this.o.sendWebhook(c.webhook_url, { event, data, at: this.now() }); } catch { /* best effort */ }
    }
  }

  // ---------- auth ----------
  vendorByKey(key: string) {
    const v = this.get("SELECT * FROM vendors WHERE api_key_hash=?", sha256(key));
    if (!v) throw new HttpError(401, "invalid vendor key");
    return v;
  }
  clientByKey(key: string) {
    const c = this.get("SELECT * FROM clients WHERE api_key_hash=?", sha256(key));
    if (!c) throw new HttpError(401, "invalid client key");
    return c;
  }

  // ---------- admin ----------
  createAccessCode() {
    const code = newSecret("code").slice(0, 16);
    this.run("INSERT INTO access_codes(code,created_at) VALUES(?,?)", code, this.now());
    this.audit("admin", "access_code.created", code);
    return code;
  }
  listVendors(status?: string) {
    return status ? this.all("SELECT id,name,email,business_id,status,created_at FROM vendors WHERE status=?", status)
      : this.all("SELECT id,name,email,business_id,status,created_at FROM vendors");
  }
  decideVendor(id: string, approve: boolean, reason: string) {
    if (!reason) throw bad("a reason is required");
    const v = this.get("SELECT id FROM vendors WHERE id=?", id);
    if (!v) throw notFound("vendor not found");
    this.run("UPDATE vendors SET status=? WHERE id=?", approve ? "approved" : "rejected", id);
    this.audit("admin", approve ? "vendor.approved" : "vendor.rejected", id, { reason });
  }

  // ---------- vendor onboarding ----------
  signupVendor(i: { name: string; email: string; phone?: string; businessId: string; accessCode: string }) {
    if (!i.name || !i.email) throw bad("name and email required");
    if (!/^\d{2}-\d{7}$/.test(i.businessId)) throw bad("business ID must look like an EIN: 12-3456789");
    const code = this.get("SELECT * FROM access_codes WHERE code=?", i.accessCode);
    if (!code || code.used_by) throw forbidden("invalid or used access code");
    const id = newId("ven");
    const key = newSecret("adl_v");
    this.tx(() => {
      this.run("INSERT INTO vendors(id,name,email,phone,business_id,api_key_hash,created_at) VALUES(?,?,?,?,?,?,?)",
        id, i.name, i.email, i.phone ?? "", i.businessId, sha256(key), this.now());
      this.run("UPDATE access_codes SET used_by=? WHERE code=?", id, i.accessCode);
    });
    this.audit(id, "vendor.signup", id);
    return { vendorId: id, apiKey: key, status: "pending" };
  }
  updateVendorSettings(vendorId: string, s: { confirmChannel?: "email" | "sms" | "dashboard"; autoApproveUnder?: number }) {
    if (s.confirmChannel) this.run("UPDATE vendors SET confirm_channel=? WHERE id=?", s.confirmChannel, vendorId);
    if (s.autoApproveUnder != null) {
      if (s.autoApproveUnder < 0) throw bad("autoApproveUnder must be >= 0");
      this.run("UPDATE vendors SET auto_approve_under=? WHERE id=?", s.autoApproveUnder, vendorId);
    }
    this.audit(vendorId, "vendor.settings", vendorId, s);
  }
  setCategoryDefaults(vendorId: string, category: string, d: {
    floorPct: number; targetPct: number; maxDiscountPct: number; warrantyDays?: number; returnWindowDays?: number; warrantyCostPerDay?: number;
  }) {
    if (!(d.floorPct > 0 && d.floorPct <= 100) || d.targetPct < d.floorPct || d.targetPct > 100) throw bad("need 0 < floor% <= target% <= 100");
    this.run(`INSERT OR REPLACE INTO vendor_defaults VALUES(?,?,?,?,?,?,?,?)`, vendorId, category.toLowerCase(),
      d.floorPct, d.targetPct, d.maxDiscountPct, d.warrantyDays ?? 0, d.returnWindowDays ?? 7, d.warrantyCostPerDay ?? 0);
    // apply to items of that category that have no manual override
    this.audit(vendorId, "vendor.defaults", category, d);
  }

  /** Deterministic stand-in for "AI-filled titles and specs". Swap for an LLM call behind the same shape. */
  fillItem(raw: { title: string; specs?: string }) {
    const text = `${raw.title} ${raw.specs ?? ""}`;
    const specs: string[] = [];
    for (const m of text.matchAll(/\b(\d{1,2}\s?GB|\d{3,4}\s?GB|\d(?:\.\d)?\s?TB|M[1-4](?: Pro| Max)?|i[3579]-?\d{0,5}|\d{1,2}["”]|OLED|5G)\b/gi))
      specs.push(m[1].replace(/\s+/g, "").toUpperCase());
    const title = raw.title.trim().replace(/\s+/g, " ").replace(/\b([a-z])/g, (c) => c.toUpperCase());
    return { title, specs: [...new Set(specs)] };
  }

  importCsv(vendorId: string, csv: string) {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw bad("CSV needs a header and at least one row");
    const head = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();
    const need = ["title", "category", "price"];
    for (const n of need) if (!head.includes(n)) throw bad(`missing column: ${n}`);
    const imported: string[] = [];
    const errors: { row: number; error: string }[] = [];
    lines.slice(1).forEach((line, idx) => {
      const r = splitCsv(line);
      const rowNo = idx + 2;
      try {
        const price = Math.round(parseFloat(col(r, "price")) * 100);
        if (!(price >= 10_000 && price <= 200_000)) throw new Error("price must be between $100 and $2,000");
        const stock = parseInt(col(r, "stock") || "1", 10);
        if (!(stock >= 0)) throw new Error("bad stock");
        const category = col(r, "category").toLowerCase();
        if (!category) throw new Error("category required");
        const filled = this.fillItem({ title: col(r, "title"), specs: col(r, "specs") });
        if (!filled.title) throw new Error("title required");
        const id = newId("itm");
        const floorCol = col(r, "floor") ? Math.round(parseFloat(col(r, "floor")) * 100) : null;
        this.tx(() => {
          this.run(`INSERT INTO items(id,vendor_id,title,category,specs,condition,list_price,stock,status,photo_url,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, vendorId, filled.title, category, JSON.stringify(filled.specs),
            col(r, "condition") || "used", price, stock, stock > 0 ? "live" : "sold", col(r, "photo_url"), this.now());
          this.applyRules(vendorId, id, category, price, floorCol);
        });
        imported.push(id);
      } catch (e: any) { errors.push({ row: rowNo, error: e.message }); }
    });
    this.audit(vendorId, "items.import", "", { imported: imported.length, errors: errors.length });
    return { imported: imported.length, itemIds: imported, errors };
  }
  private applyRules(vendorId: string, itemId: string, category: string, list: number, floorOverride: number | null) {
    const d = this.get("SELECT * FROM vendor_defaults WHERE vendor_id=? AND category=?", vendorId, category);
    const floor = floorOverride ?? Math.round(list * ((d?.floor_pct ?? 85) / 100));
    const target = Math.max(floor, Math.round(list * ((d?.target_pct ?? 95) / 100)));
    const wd = d?.warranty_days ?? 0;
    this.run(`INSERT OR REPLACE INTO item_rules VALUES(?,?,?,?,?,?,?,?)`, itemId, floor, target,
      d?.max_discount_pct ?? 15, JSON.stringify(wd ? [0, wd] : [0]), d?.warranty_cost_per_day ?? 0, d?.return_window_days ?? 7, 2);
  }
  setItemRules(vendorId: string, itemId: string, r: Partial<{
    floor: number; target: number; maxDiscountPct: number; warrantyOptions: number[]; warrantyCostPerDay: number; returnWindowDays: number; leadDays: number;
  }>) {
    const item = this.ownedItem(vendorId, itemId);
    const cur = this.get("SELECT * FROM item_rules WHERE item_id=?", itemId)!;
    const floor = r.floor ?? cur.floor;
    const target = r.target ?? cur.target;
    if (floor <= 0 || target < floor || target > item.list_price) throw bad("need 0 < floor <= target <= list price");
    this.run(`UPDATE item_rules SET floor=?,target=?,max_discount_pct=?,warranty_options=?,warranty_cost_per_day=?,return_window_days=?,lead_days=? WHERE item_id=?`,
      floor, target, r.maxDiscountPct ?? cur.max_discount_pct, JSON.stringify(r.warrantyOptions ?? JSON.parse(cur.warranty_options)),
      r.warrantyCostPerDay ?? cur.warranty_cost_per_day, r.returnWindowDays ?? cur.return_window_days, r.leadDays ?? cur.lead_days, itemId);
    this.audit(vendorId, "item.rules", itemId, r);
  }
  setStock(vendorId: string, itemId: string, stock: number) {
    this.ownedItem(vendorId, itemId);
    if (!(stock >= 0)) throw bad("bad stock");
    this.run("UPDATE items SET stock=?, status=? WHERE id=?", stock, stock > 0 ? "live" : "sold", itemId);
  }
  private ownedItem(vendorId: string, itemId: string) {
    const it = this.get("SELECT * FROM items WHERE id=? AND vendor_id=?", itemId, vendorId);
    if (!it) throw notFound("item not found");
    return it;
  }
  listItems(vendorId: string) {
    return this.all("SELECT i.*, r.floor, r.target, r.max_discount_pct, r.warranty_options, r.lead_days FROM items i JOIN item_rules r ON r.item_id=i.id WHERE vendor_id=?", vendorId);
  }

  // ---------- client ----------
  signupClient(i: { name: string; email: string; pin: string }) {
    if (!/^\d{4,8}$/.test(i.pin)) throw bad("approval PIN must be 4 to 8 digits");
    if (this.get("SELECT 1 FROM clients WHERE email=?", i.email)) throw bad("email already registered");
    const id = newId("cli");
    const key = newSecret("adl_c");
    this.run("INSERT INTO clients(id,name,email,api_key_hash,pin_hash,created_at) VALUES(?,?,?,?,?,?)",
      id, i.name, i.email, sha256(key), hashPin(i.pin), this.now());
    this.audit(id, "client.signup", id);
    return { clientId: id, apiKey: key };
  }
  loginClient(email: string, pin: string) {
    const c = this.get("SELECT * FROM clients WHERE email=?", email);
    if (!c || !checkPin(pin, c.pin_hash)) throw new HttpError(401, "wrong email or PIN");
    return c;
  }
  setWebhook(clientId: string, url: string) {
    if (!/^https:\/\//.test(url)) throw bad("webhook must be https");
    this.run("UPDATE clients SET webhook_url=? WHERE id=?", url, clientId);
  }
  getProfile(clientId: string) {
    const c = this.get("SELECT profile_enc FROM clients WHERE id=?", clientId)!;
    return c.profile_enc ? JSON.parse(decrypt(c.profile_enc, this.key)) : {};
  }
  putProfile(clientId: string, profile: unknown) {
    if (JSON.stringify(profile ?? {}).length > 20_000) throw bad("profile too large");
    this.run("UPDATE clients SET profile_enc=? WHERE id=?", encrypt(JSON.stringify(profile), this.key), clientId);
    this.audit(clientId, "profile.updated", clientId);
  }
  exportClient(clientId: string) {
    return {
      profile: this.getProfile(clientId),
      mandates: this.all("SELECT * FROM mandates WHERE client_id=?", clientId),
      quotes: this.all("SELECT id,mandate_id,item_id,price,warranty_days,status,created_at FROM quotes WHERE client_id=?", clientId),
      deals: this.all("SELECT * FROM deals WHERE client_id=?", clientId),
      decisionLog: this.all("SELECT * FROM decision_log WHERE user_type='client' AND user_id=?", clientId),
    };
  }
  deleteClient(clientId: string) {
    const open = this.get("SELECT COUNT(*) n FROM deals WHERE client_id=? AND status IN ('paid_held','shipped','delivered','disputed')", clientId)!;
    if (open.n) throw bad("finish or settle open deals before deleting your account");
    this.tx(() => {
      this.run("DELETE FROM decision_log WHERE user_type='client' AND user_id=?", clientId);
      this.run("DELETE FROM mandates WHERE client_id=?", clientId);
      this.run("DELETE FROM clients WHERE id=?", clientId);
    });
    this.audit(clientId, "client.deleted", clientId);
  }

  // ---------- mandate -> matching -> quotes ----------
  async createMandate(clientId: string, m: {
    query: string; category?: string; mustHaves?: string[]; budget: number; deadlineDays?: number; warrantyValuePerDay?: number;
  }) {
    const q = screen(m.query);
    const must = (m.mustHaves ?? []).map((s) => screen(s));
    const flags = [...q.flags, ...must.flatMap((x) => x.flags)];
    if (flags.length) {
      this.audit(clientId, "safety.blocked", "mandate", { flags });
      throw bad(`mandate rejected by safety filter: ${[...new Set(flags)].join(", ")}`);
    }
    if (!q.clean) throw bad("query required");
    if (!(m.budget >= 10_000 && m.budget <= 200_000)) throw bad("budget must be between $100 and $2,000 (in cents: 10000-200000)");
    const id = newId("man");
    this.run(`INSERT INTO mandates(id,client_id,query,category,must_haves,budget,deadline_days,warranty_value_per_day,created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`, id, clientId, q.clean, (m.category ?? "").toLowerCase(),
      JSON.stringify(must.map((x) => x.clean).filter(Boolean)), m.budget, m.deadlineDays ?? null, m.warrantyValuePerDay ?? 0, this.now());
    this.logDecision("client", clientId, id, "mandate", m.budget, { query: q.clean });
    this.audit(clientId, "mandate.created", id);
    this.runMatching(id);
    return { mandateId: id };
  }

  private tokens(s: string) {
    return s.toLowerCase().split(/[^a-z0-9"+.-]+/).filter((t) => t.length > 1);
  }

  runMatching(mandateId: string) {
    const m = this.get("SELECT * FROM mandates WHERE id=?", mandateId)!;
    const must: string[] = JSON.parse(m.must_haves);
    const queryTokens = this.tokens(m.query);
    const items = this.all(`SELECT i.*, v.status vstatus, v.auto_approve_under, v.confirm_channel, v.email vemail, v.phone vphone, v.name vname
       FROM items i JOIN vendors v ON v.id=i.vendor_id
       WHERE v.status='approved' AND i.status='live' AND i.stock>0 ${m.category ? "AND i.category=?" : ""}`, ...(m.category ? [m.category] : []));
    for (const it of items) {
      const hay = this.tokens(`${it.title} ${JSON.parse(it.specs).join(" ")} ${it.category} ${it.condition}`);
      const hits = queryTokens.filter((t) => hay.some((h) => h.includes(t))).length;
      if (queryTokens.length && hits < Math.max(1, Math.ceil(queryTokens.length / 2))) continue;
      if (!must.every((req) => this.tokens(req).every((t) => hay.some((h) => h.includes(t))))) continue;
      this.run("UPDATE items SET views=views+1 WHERE id=?", it.id);
      this.runOneQuote(m, it);
    }
    this.run("UPDATE mandates SET status='quoted' WHERE id=?", mandateId);
  }

  private runOneQuote(m: Row, it: Row) {
    const rules = this.get("SELECT * FROM item_rules WHERE item_id=?", it.id)!;
    const vt: VendorTerms = {
      list: it.list_price, floor: rules.floor, target: rules.target, maxDiscountPct: rules.max_discount_pct,
      warrantyOptions: JSON.parse(rules.warranty_options), warrantyCostPerDay: rules.warranty_cost_per_day, leadDays: rules.lead_days,
    };
    const bt: BuyerTerms = { budget: m.budget, warrantyValuePerDay: m.warranty_value_per_day, deadlineDays: m.deadline_days };
    const quoteId = newId("quo");
    const res = negotiate(vt, bt, seedFrom(`${m.id}:${it.id}`));
    const lead = (outcome: string, reason: string) =>
      this.run("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?)", newId("led"), it.vendor_id, it.id, m.id, quoteId, outcome, reason, this.now());

    if (!res.agreed) {
      this.run(`INSERT INTO quotes(id,mandate_id,item_id,vendor_id,client_id,price,warranty_days,status,reason,created_at)
                VALUES(?,?,?,?,?,0,0,'lost',?,?)`, quoteId, m.id, it.id, it.vendor_id, m.client_id, res.reason, this.now());
      lead("lost", res.reason);
      this.logDecision("client", m.client_id, quoteId, "reject", null, { reason: res.reason, item: it.id });
      return;
    }
    const token = newSecret("cf");
    const auto = res.price < it.auto_approve_under;
    const status = auto ? "vendor_confirmed" : "awaiting_vendor";
    this.tx(() => {
      this.run(`INSERT INTO quotes(id,mandate_id,item_id,vendor_id,client_id,price,warranty_days,status,expires_at,confirm_token_hash,auto_approved,created_at,confirmed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, quoteId, m.id, it.id, it.vendor_id, m.client_id, res.price, res.warrantyDays,
        status, this.now() + (auto ? CLIENT_APPROVAL_WINDOW : VENDOR_CONFIRM_WINDOW), sha256(token), auto ? 1 : 0, this.now(), auto ? this.now() : null);
      for (const t of res.turns) {
        this.run("INSERT INTO negotiation_turns(quote_id,seq,side,kind,price,warranty_days) VALUES(?,?,?,?,?,?)",
          quoteId, t.seq, t.side, t.kind, t.price, t.warrantyDays);
        if (t.side === "buyer") this.logDecision("client", m.client_id, quoteId, "offer", t.price);
        if (t.side === "vendor") this.logDecision("vendor", it.vendor_id, quoteId, t.kind === "accept" ? "accept" : t.kind === "offer" ? "offer" : "counter", t.price);
      }
      lead("quoted", "awaiting_vendor");
    });
    if (!auto) {
      const link = `${this.baseUrl}/confirm/${token}`;
      const trust = this.trust(it.vendor_id);
      const body = `Buyer asked for "${m.query}". Your agent negotiated ${it.title} at $${(res.price / 100).toFixed(2)}${res.warrantyDays ? ` with ${res.warrantyDays}-day warranty` : ""}. ` +
        `Confirm in one tap (expires in 2 hours): ${link}`;
      if (it.confirm_channel === "sms") this.notify("sms", it.vphone, "Deal to confirm", body);
      else if (it.confirm_channel === "email") this.notify("email", it.vemail, "Confirm deal", body);
      void trust;
    }
  }

  trust(vendorId: string) {
    const v = this.get("SELECT status FROM vendors WHERE id=?", vendorId);
    const done = this.get("SELECT COUNT(*) n FROM deals WHERE vendor_id=? AND status IN ('released','delivered')", vendorId)!.n;
    const all = this.get("SELECT COUNT(*) n FROM deals WHERE vendor_id=? AND status!='paid_held'", vendorId)!.n;
    const onTime = this.get("SELECT COUNT(*) n FROM deals WHERE vendor_id=? AND delivered_at IS NOT NULL AND delivered_at<=promised_by", vendorId)!.n;
    const delivered = this.get("SELECT COUNT(*) n FROM deals WHERE vendor_id=? AND delivered_at IS NOT NULL", vendorId)!.n;
    const disputes = this.get("SELECT COUNT(*) n FROM disputes d JOIN deals dl ON dl.id=d.deal_id WHERE dl.vendor_id=?", vendorId)!.n;
    return {
      verified: v?.status === "approved",
      completedDeals: done,
      onTimeRate: delivered ? Math.round((onTime / delivered) * 100) : null,
      disputeRate: all ? Math.round((disputes / all) * 100) : null,
    };
  }

  /** Quotes for a mandate: best 3 that a vendor has confirmed, cheapest first (ties: most trusted). */
  getQuotes(clientId: string, mandateId: string) {
    const m = this.get("SELECT * FROM mandates WHERE id=? AND client_id=?", mandateId, clientId);
    if (!m) throw notFound("mandate not found");
    this.tick();
    const rows = this.all(`SELECT q.*, i.title, i.condition, i.category, v.name vname FROM quotes q
        JOIN items i ON i.id=q.item_id JOIN vendors v ON v.id=q.vendor_id
        WHERE q.mandate_id=? AND q.status IN ('vendor_confirmed')`, mandateId);
    const quotes = rows.map((q) => ({
      quoteId: q.id, item: q.title, condition: q.condition, vendor: q.vname,
      priceCents: q.price, price: `$${(q.price / 100).toFixed(2)}`, warrantyDays: q.warranty_days,
      expiresAt: q.expires_at, trust: this.trust(q.vendor_id),
      approvalUrl: `${this.baseUrl}/approve/${q.id}`, // the buyer's AI can only hand over this link
    })).sort((a, b) => a.priceCents - b.priceCents || (b.trust.completedDeals - a.trust.completedDeals)).slice(0, 3);
    const pending = this.get("SELECT COUNT(*) n FROM quotes WHERE mandate_id=? AND status='awaiting_vendor'", mandateId)!.n;
    return { mandateId, quotes, awaitingVendors: pending };
  }

  // ---------- vendor confirmation ----------
  confirmByToken(token: string, accept: boolean) {
    const q = this.get("SELECT * FROM quotes WHERE confirm_token_hash=?", sha256(token));
    if (!q) throw notFound("link not valid");
    return this.vendorDecision(q.vendor_id, q.id, accept);
  }
  quoteByConfirmToken(token: string) {
    this.tick();
    const q = this.get(`SELECT q.id, q.status, q.price, q.warranty_days, q.expires_at, i.title, m.query FROM quotes q
      JOIN items i ON i.id=q.item_id JOIN mandates m ON m.id=q.mandate_id WHERE q.confirm_token_hash=?`, sha256(token));
    if (!q) throw notFound("link not valid");
    return q;
  }
  vendorDecision(vendorId: string, quoteId: string, accept: boolean) {
    this.tick();
    const q = this.get("SELECT * FROM quotes WHERE id=? AND vendor_id=?", quoteId, vendorId);
    if (!q) throw notFound("quote not found");
    if (q.status !== "awaiting_vendor") throw bad(`quote is ${q.status}`);
    if (accept) {
      this.run("UPDATE quotes SET status='vendor_confirmed', confirmed_at=?, expires_at=? WHERE id=?",
        this.now(), this.now() + CLIENT_APPROVAL_WINDOW, quoteId);
      this.logDecision("vendor", vendorId, quoteId, "accept", q.price);
      this.run("UPDATE leads SET reason='confirmed' WHERE quote_id=?", quoteId);
    } else {
      this.run("UPDATE quotes SET status='declined', reason='vendor_declined' WHERE id=?", quoteId);
      this.run("UPDATE leads SET outcome='lost', reason='vendor_declined' WHERE quote_id=?", quoteId);
      this.logDecision("vendor", vendorId, quoteId, "reject", q.price);
    }
    this.audit(vendorId, accept ? "quote.vendor_confirmed" : "quote.vendor_declined", quoteId);
    void this.webhook(q.client_id, accept ? "quote.ready" : "quote.declined", { quoteId });
    return { quoteId, status: accept ? "vendor_confirmed" : "declined" };
  }

  // ---------- client approval and payment (human only) ----------
  quoteForApproval(quoteId: string) {
    this.tick();
    const q = this.get(`SELECT q.*, i.title, i.condition, r.return_window_days, v.name vname FROM quotes q
      JOIN items i ON i.id=q.item_id JOIN item_rules r ON r.item_id=i.id JOIN vendors v ON v.id=q.vendor_id WHERE q.id=?`, quoteId);
    if (!q) throw notFound("quote not found");
    const out: Row = Object.assign({}, q);
    out.trust = this.trust(q.vendor_id);
    return out as Row & { trust: ReturnType<Platform["trust"]> };
  }

  /** The ONLY path that moves money. Requires the client's PIN, which the buyer's AI never holds. */
  async approveQuote(quoteId: string, pin: string, method: "pickup" | "shipping" = "pickup") {
    this.tick();
    const q = this.get("SELECT * FROM quotes WHERE id=?", quoteId);
    if (!q) throw notFound("quote not found");
    const client = this.get("SELECT * FROM clients WHERE id=?", q.client_id)!;
    const fails = this.get("SELECT COUNT(*) n FROM audit_log WHERE actor=? AND event='approval.bad_pin' AND created_at>?", q.client_id, this.now() - HOUR)!.n;
    if (fails >= 5) throw new HttpError(429, "too many wrong PINs, try again in an hour");
    if (!checkPin(pin, client.pin_hash)) {
      this.audit(q.client_id, "approval.bad_pin", quoteId);
      throw forbidden("wrong PIN");
    }
    if (q.status !== "vendor_confirmed") throw bad(`quote is ${q.status}`);
    const m = this.get("SELECT * FROM mandates WHERE id=?", q.mandate_id)!;
    const rules = this.get("SELECT * FROM item_rules WHERE item_id=?", q.item_id)!;
    const item = this.get("SELECT * FROM items WHERE id=?", q.item_id)!;
    // Hard checks again at the moment of payment.
    if (q.price < rules.floor) throw new MandateViolation("price below vendor floor");
    if (q.price > m.budget) throw new MandateViolation("price above client budget");
    if (item.stock < 1) throw bad("item no longer in stock");

    const dealId = newId("dea");
    let hold: { ref: string };
    try { hold = await this.escrow.hold(dealId, q.price); }
    catch (e: any) { // a failed payment never leaves a deal half-done: nothing is written
      this.audit(q.client_id, "escrow.hold_failed", quoteId, { error: e.message });
      throw new HttpError(502, "payment partner unavailable, nothing was charged");
    }
    this.tx(() => {
      this.run(`INSERT INTO deals(id,quote_id,client_id,vendor_id,item_id,price,warranty_days,status,method,promised_by,created_at)
                VALUES(?,?,?,?,?,?,?,'paid_held',?,?,?)`, dealId, quoteId, q.client_id, q.vendor_id, q.item_id, q.price, q.warranty_days,
        method, this.now() + (rules.lead_days + (method === "shipping" ? 3 : 0)) * DAY, this.now());
      this.run("INSERT INTO escrow VALUES(?,?,?,?,?,?,?)", newId("esc"), dealId, this.escrow.name, hold.ref, q.price, "held", this.now());
      this.run("UPDATE quotes SET status='client_approved' WHERE id=?", quoteId);
      this.run("UPDATE items SET stock=stock-1 WHERE id=?", q.item_id);
      this.run("UPDATE items SET status='sold' WHERE id=? AND stock<=0", q.item_id);
      this.run("UPDATE leads SET outcome='won', reason='deal' WHERE quote_id=?", quoteId);
      this.run("UPDATE mandates SET status='closed' WHERE id=?", q.mandate_id);
      // other quotes for this mandate close as lost
      for (const o of this.all("SELECT id,vendor_id FROM quotes WHERE mandate_id=? AND id!=? AND status IN ('awaiting_vendor','vendor_confirmed')", q.mandate_id, quoteId)) {
        this.run("UPDATE quotes SET status='lost', reason='buyer_chose_other' WHERE id=?", o.id);
        this.run("UPDATE leads SET outcome='lost', reason='buyer_chose_other' WHERE quote_id=?", o.id);
      }
    });
    this.logDecision("client", q.client_id, quoteId, "accept", q.price);
    this.audit(q.client_id, "deal.created", dealId, { price: q.price, escrow: hold.ref });
    this.notify("email", this.get("SELECT email FROM vendors WHERE id=?", q.vendor_id)!.email, "Deal paid into escrow", `Deal ${dealId} is paid and held. Hand over the item to release funds.`);
    void this.webhook(q.client_id, "deal.paid", { dealId });
    return { dealId, status: "paid_held" };
  }
  declineQuote(quoteId: string, pin: string) {
    const q = this.get("SELECT * FROM quotes WHERE id=?", quoteId);
    if (!q) throw notFound("quote not found");
    const client = this.get("SELECT * FROM clients WHERE id=?", q.client_id)!;
    if (!checkPin(pin, client.pin_hash)) throw forbidden("wrong PIN");
    if (q.status !== "vendor_confirmed") throw bad(`quote is ${q.status}`);
    this.run("UPDATE quotes SET status='declined', reason='buyer_declined' WHERE id=?", quoteId);
    this.run("UPDATE leads SET outcome='lost', reason='buyer_declined' WHERE quote_id=?", quoteId);
    this.logDecision("client", q.client_id, quoteId, "reject", q.price);
  }

  // ---------- delivery, release, disputes ----------
  vendorMarkDelivered(vendorId: string, dealId: string) {
    const d = this.get("SELECT * FROM deals WHERE id=? AND vendor_id=?", dealId, vendorId);
    if (!d) throw notFound("deal not found");
    if (d.status !== "paid_held" && d.status !== "shipped") throw bad(`deal is ${d.status}`);
    this.run("UPDATE deals SET status='delivered', delivered_at=?, release_at=? WHERE id=?", this.now(), this.now() + AUTO_RELEASE, dealId);
    this.audit(vendorId, "deal.delivered", dealId);
    void this.webhook(d.client_id, "deal.delivered", { dealId });
    return { dealId, status: "delivered", autoReleaseAt: this.now() + AUTO_RELEASE };
  }
  vendorMarkShipped(vendorId: string, dealId: string) {
    const d = this.get("SELECT * FROM deals WHERE id=? AND vendor_id=?", dealId, vendorId);
    if (!d) throw notFound("deal not found");
    if (d.status !== "paid_held") throw bad(`deal is ${d.status}`);
    this.run("UPDATE deals SET status='shipped' WHERE id=?", dealId);
    this.audit(vendorId, "deal.shipped", dealId);
  }
  async clientConfirmDelivery(clientId: string, dealId: string) {
    const d = this.get("SELECT * FROM deals WHERE id=? AND client_id=?", dealId, clientId);
    if (!d) throw notFound("deal not found");
    if (!["paid_held", "shipped", "delivered"].includes(d.status)) throw bad(`deal is ${d.status}`);
    if (d.status === "paid_held" || d.status === "shipped") this.run("UPDATE deals SET delivered_at=? WHERE id=?", this.now(), dealId);
    await this.release(dealId, `client:${clientId}`);
    return { dealId, status: "released" };
  }
  private async release(dealId: string, actor: string) {
    const e = this.get("SELECT * FROM escrow WHERE deal_id=?", dealId)!;
    await this.escrow.release(e.provider_ref);
    this.tx(() => {
      this.run("UPDATE escrow SET state='released', updated_at=? WHERE deal_id=?", this.now(), dealId);
      this.run("UPDATE deals SET status='released' WHERE id=?", dealId);
    });
    this.audit(actor, "escrow.released", dealId);
  }
  async openDispute(clientId: string, dealId: string, reason: string) {
    const d = this.get("SELECT * FROM deals WHERE id=? AND client_id=?", dealId, clientId);
    if (!d) throw notFound("deal not found");
    const r = screen(reason);
    if (!r.ok) { this.audit(clientId, "safety.blocked", "dispute", { flags: r.flags }); throw bad("dispute text rejected by safety filter"); }
    if (!r.clean) throw bad("reason required");
    if (!["paid_held", "shipped", "delivered"].includes(d.status)) throw bad(`deal is ${d.status}: cannot dispute`);
    if (d.delivered_at && this.now() > d.delivered_at + DISPUTE_WINDOW) throw bad("dispute window (3 days after delivery) has passed");
    const id = newId("dis");
    this.run("INSERT INTO disputes(id,deal_id,reason,created_at) VALUES(?,?,?,?)", id, dealId, r.clean, this.now());
    this.run("UPDATE deals SET status='disputed' WHERE id=?", dealId); // money stays held
    this.audit(clientId, "dispute.opened", id, { dealId });
    return { disputeId: id, status: "open", moneyStatus: "held" };
  }
  listDisputes(status = "open") {
    return this.all(`SELECT d.*, dl.price, dl.vendor_id, dl.client_id, i.title FROM disputes d
      JOIN deals dl ON dl.id=d.deal_id JOIN items i ON i.id=dl.item_id WHERE d.status=?`, status);
  }
  async decideDispute(disputeId: string, decision: "refund" | "release", reason: string) {
    if (!reason) throw bad("a reason is required");
    const x = this.get("SELECT * FROM disputes WHERE id=?", disputeId);
    if (!x) throw notFound("dispute not found");
    if (x.status !== "open") throw bad("already resolved");
    const e = this.get("SELECT * FROM escrow WHERE deal_id=?", x.deal_id)!;
    if (decision === "refund") await this.escrow.refund(e.provider_ref); else await this.escrow.release(e.provider_ref);
    this.tx(() => {
      this.run("UPDATE escrow SET state=?, updated_at=? WHERE deal_id=?", decision === "refund" ? "refunded" : "released", this.now(), x.deal_id);
      this.run("UPDATE deals SET status=? WHERE id=?", decision === "refund" ? "refunded" : "released", x.deal_id);
      this.run("UPDATE disputes SET status='resolved', decision=?, admin_reason=?, resolved_at=? WHERE id=?", decision, reason, this.now(), disputeId);
      if (decision === "refund") { // item goes back to stock only if vendor takes it back: leave to vendor, log it
        this.audit("admin", "dispute.refund_item_return_pending", x.deal_id);
      }
    });
    this.audit("admin", `dispute.${decision}`, disputeId, { reason });
    return { disputeId, decision };
  }
  dealStatus(clientId: string, dealId: string) {
    const d = this.get(`SELECT d.*, e.state escrow_state FROM deals d JOIN escrow e ON e.deal_id=d.id WHERE d.id=? AND d.client_id=?`, dealId, clientId);
    if (!d) throw notFound("deal not found");
    return { dealId, status: d.status, escrow: d.escrow_state, priceCents: d.price, warrantyDays: d.warranty_days,
      deliveredAt: d.delivered_at, autoReleaseAt: d.release_at };
  }

  /** Time-based transitions: expire quotes, auto-release after 3 days. Safe to call often. */
  tick() {
    const t = this.now();
    for (const q of this.all("SELECT * FROM quotes WHERE status IN ('awaiting_vendor','vendor_confirmed') AND expires_at<?", t)) {
      const reason = q.status === "awaiting_vendor" ? "no_reply" : "buyer_no_action";
      this.run("UPDATE quotes SET status='expired', reason=? WHERE id=?", reason, q.id);
      this.run("UPDATE leads SET outcome='lost', reason=? WHERE quote_id=?", reason, q.id);
    }
    const due = this.all("SELECT id FROM deals WHERE status='delivered' AND release_at IS NOT NULL AND release_at<=?", t);
    for (const d of due) void this.release(d.id, "system:auto_release").catch((e) => this.audit("system", "escrow.release_failed", d.id, { error: String(e) }));
  }
  /** Await-able variant for tests and schedulers. */
  async tickAsync() {
    this.tick();
    await new Promise((r) => setTimeout(r, 0));
  }

  // ---------- CRM, analytics, pricing ----------
  leads(vendorId: string) {
    return this.all(`SELECT l.created_at, l.outcome, l.reason, i.title, m.query, m.budget, q.price
      FROM leads l JOIN items i ON i.id=l.item_id JOIN mandates m ON m.id=l.mandate_id LEFT JOIN quotes q ON q.id=l.quote_id
      WHERE l.vendor_id=? ORDER BY l.created_at DESC`, vendorId);
  }
  funnel(vendorId: string) {
    return this.all(`SELECT i.id itemId, i.title, i.views,
        (SELECT COUNT(*) FROM leads l WHERE l.item_id=i.id) quoteRequests,
        (SELECT COUNT(*) FROM leads l WHERE l.item_id=i.id AND l.outcome='won') deals,
        COALESCE((SELECT SUM(d.price) FROM deals d WHERE d.item_id=i.id),0) revenue
      FROM items i WHERE i.vendor_id=?`, vendorId);
  }
  billing(vendorId: string) { return this.all("SELECT day, confirmed_quotes FROM v_billing WHERE vendor_id=? ORDER BY day", vendorId); }

  private median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2)) : null; }
  pricing(vendorId: string) {
    return this.listItems(vendorId).map((it) => {
      const peers = this.all("SELECT list_price FROM items WHERE category=? AND vendor_id!=? AND status='live'", it.category, vendorId).map((r) => r.list_price);
      const med = this.median(peers);
      const f = this.get(`SELECT (SELECT COUNT(*) FROM leads WHERE item_id=?) req, (SELECT COUNT(*) FROM leads WHERE item_id=? AND outcome='lost' AND reason='price') priceLosses`, it.id, it.id)!;
      let suggestion: number | null = null; let why = "";
      if (med && it.list_price > med * 1.1 && f.priceLosses > 0) { suggestion = Math.max(it.floor, med); why = `Listed ${Math.round((it.list_price / med - 1) * 100)}% above the market median and ${f.priceLosses} lead(s) were lost on price.`; }
      return { itemId: it.id, title: it.title, listPrice: it.list_price, marketMedian: med, suggestedPrice: suggestion, reason: why };
    });
  }
  acceptPriceSuggestion(vendorId: string, itemId: string) {
    const s = this.pricing(vendorId).find((p) => p.itemId === itemId);
    if (!s?.suggestedPrice) throw bad("no suggestion for this item");
    const r = this.get("SELECT * FROM item_rules WHERE item_id=?", itemId)!;
    this.run("UPDATE items SET list_price=? WHERE id=?", s.suggestedPrice, itemId);
    this.run("UPDATE item_rules SET target=MIN(target,?) WHERE item_id=?", s.suggestedPrice, itemId);
    void r;
    this.audit(vendorId, "price.suggestion_accepted", itemId, { price: s.suggestedPrice });
    return { itemId, listPrice: s.suggestedPrice };
  }

  /** Simulated-buyer preview: run N random buyers against an item before going live. */
  preview(vendorId: string, itemId: string, n = 200) {
    const it = this.ownedItem(vendorId, itemId);
    const r = this.get("SELECT * FROM item_rules WHERE item_id=?", itemId)!;
    const vt: VendorTerms = { list: it.list_price, floor: r.floor, target: r.target, maxDiscountPct: r.max_discount_pct,
      warrantyOptions: JSON.parse(r.warranty_options), warrantyCostPerDay: r.warranty_cost_per_day, leadDays: r.lead_days };
    let closed = 0, sum = 0, minPrice = Infinity, breaches = 0;
    for (let k = 0; k < n; k++) {
      const budget = Math.round(it.list_price * (0.6 + 0.6 * ((seedFrom(`pv${k}`) % 1000) / 1000)));
      const res = negotiate(vt, { budget, warrantyValuePerDay: 0, deadlineDays: null }, 1000 + k);
      if (res.agreed) { closed++; sum += res.price; minPrice = Math.min(minPrice, res.price); if (res.price < r.floor) breaches++; }
    }
    return { simulatedBuyers: n, closeRate: Math.round((closed / n) * 100), avgPrice: closed ? Math.round(sum / closed) : null,
      lowestPrice: closed ? minPrice : null, belowFloorDeals: breaches, hardMin: vendorHardMin(vt) };
  }

  decisionLog(userType: "vendor" | "client", userId: string) {
    return this.all("SELECT ref,event,price,detail,created_at FROM decision_log WHERE user_type=? AND user_id=? ORDER BY id", userType, userId);
  }
  vendorDeals(vendorId: string) { return this.all("SELECT d.*, i.title FROM deals d JOIN items i ON i.id=d.item_id WHERE d.vendor_id=?", vendorId); }
  pendingQuotesForVendor(vendorId: string) {
    return this.all(`SELECT q.id, q.price, q.warranty_days, q.expires_at, i.title FROM quotes q JOIN items i ON i.id=q.item_id WHERE q.vendor_id=? AND q.status='awaiting_vendor'`, vendorId);
  }
  outbox() { return this.all("SELECT * FROM outbox ORDER BY id"); }
  auditLog(ref?: string) { return ref ? this.all("SELECT * FROM audit_log WHERE ref=? ORDER BY id", ref) : this.all("SELECT * FROM audit_log ORDER BY id"); }
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
