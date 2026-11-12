import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDb } from "./db.js";
import { Platform, HttpError } from "./service.js";
import { SimulatedEscrow, StripeConnectEscrow } from "./escrow.js";
import { createMcpServer } from "./mcp.js";
import { MandateViolation } from "./engine.js";
import { layout, esc, usd, when } from "./web.js";
import { registerHearth, seedHearth } from "./hearth.js";

type Session = { role: "client" | "vendor" | "admin"; id: string };

export function buildApp(p: Platform, adminKey: string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  const sessions = new Map<string, Session>();
  const hits = new Map<string, { n: number; t: number }>();

  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_r, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // ---- rate limit: 120 requests/minute per IP ----
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url.startsWith("/hearth/")) return; // the Hearth shell polls each agent about every 0.65 s
    const k = req.ip; const t = Date.now(); const h = hits.get(k);
    if (!h || t - h.t > 60_000) hits.set(k, { n: 1, t }); else if (++h.n > 120) { reply.code(429).send({ error: "rate limit" }); }
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof MandateViolation) return reply.code(409).send({ error: e.message });
    if (e.validation || e.statusCode === 400) return reply.code(400).send({ error: e.message });
    console.error(e);
    return reply.code(500).send({ error: "internal error" });
  });

  const bearer = (req: FastifyRequest) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const vendorAuth = (req: FastifyRequest) => p.vendorByKey(bearer(req) || sess(req, "vendor")?.id || "");
  const clientAuth = (req: FastifyRequest) => p.clientByKey(bearer(req));
  const adminAuth = (req: FastifyRequest) => { if (bearer(req) !== adminKey && !sess(req, "admin")) throw new HttpError(401, "admin only"); };

  function cookie(req: FastifyRequest, name: string) {
    const m = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
  }
  function sess(req: FastifyRequest, role: Session["role"]) {
    const s = sessions.get(cookie(req, "adl_s")); return s?.role === role ? s : undefined;
  }
  function login(reply: FastifyReply, s: Session) {
    const tok = randomBytes(24).toString("base64url"); sessions.set(tok, s);
    reply.header("set-cookie", `adl_s=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  }
  const html = (reply: FastifyReply, body: string) => reply.type("text/html").send(body);

  app.get("/health", async () => ({ ok: true, escrow: p.escrow.name }));

  // =============== ADMIN API ===============
  app.post("/admin/access-codes", async (req) => { adminAuth(req); return { code: p.createAccessCode() }; });
  app.get("/admin/vendors", async (req) => { adminAuth(req); return p.listVendors((req.query as any).status); });
  app.post("/admin/vendors/:id/:action", async (req) => {
    adminAuth(req); const { id, action } = req.params as any;
    p.decideVendor(id, action === "approve", (req.body as any)?.reason ?? ""); return { ok: true };
  });
  app.get("/admin/disputes", async (req) => { adminAuth(req); return p.listDisputes((req.query as any).status ?? "open"); });
  app.post("/admin/disputes/:id/decide", async (req) => {
    adminAuth(req); const b = req.body as any;
    return p.decideDispute((req.params as any).id, b.decision, b.reason);
  });
  app.get("/admin/audit", async (req) => { adminAuth(req); return p.auditLog((req.query as any).ref); });

  // =============== VENDOR API ===============
  app.post("/vendors/signup", async (req, reply) => {
    const b = req.body as any;
    reply.code(201); return p.signupVendor({ name: b.name, email: b.email, phone: b.phone, businessId: b.businessId, accessCode: b.accessCode });
  });
  app.put("/vendor/settings", async (req) => { const v = vendorAuth(req); p.updateVendorSettings(v.id, req.body as any); return { ok: true }; });
  app.put("/vendor/defaults/:category", async (req) => { const v = vendorAuth(req); p.setCategoryDefaults(v.id, (req.params as any).category, req.body as any); return { ok: true }; });
  app.post("/vendor/items/import", async (req) => { const v = vendorAuth(req); if (v.status !== "approved") throw new HttpError(403, "vendor not approved yet"); return p.importCsv(v.id, String(req.body)); });
  app.get("/vendor/items", async (req) => p.listItems(vendorAuth(req).id));
  app.put("/vendor/items/:id/rules", async (req) => { const v = vendorAuth(req); p.setItemRules(v.id, (req.params as any).id, req.body as any); return { ok: true }; });
  app.put("/vendor/items/:id/stock", async (req) => { const v = vendorAuth(req); p.setStock(v.id, (req.params as any).id, (req.body as any).stock); return { ok: true }; });
  app.get("/vendor/items/:id/preview", async (req) => p.preview(vendorAuth(req).id, (req.params as any).id));
  app.get("/vendor/quotes/pending", async (req) => p.pendingQuotesForVendor(vendorAuth(req).id));
  app.get("/vendor/leads", async (req) => p.leads(vendorAuth(req).id));
  app.get("/vendor/funnel", async (req) => p.funnel(vendorAuth(req).id));
  app.get("/vendor/pricing", async (req) => p.pricing(vendorAuth(req).id));
  app.get("/vendor/deals", async (req) => p.vendorDeals(vendorAuth(req).id));
  app.post("/vendor/deals/:id/shipped", async (req) => { p.vendorMarkShipped(vendorAuth(req).id, (req.params as any).id); return { ok: true }; });
  app.get("/vendor/billing", async (req) => p.billing(vendorAuth(req).id));
  app.get("/vendor/decision-log", async (req) => p.decisionLog("vendor", vendorAuth(req).id));

  // =============== CLIENT API (same actions as the MCP tools) ===============
  app.post("/clients/signup", async (req, reply) => { const b = req.body as any; reply.code(201); return p.signupClient({ name: b.name, email: b.email, pin: String(b.pin) }); });
  app.post("/v1/mandates", async (req, reply) => {
    const b = req.body as any; reply.code(201);
    return p.createMandate(clientAuth(req).id, { query: b.query, category: b.category, mustHaves: b.mustHaves, budget: b.budget, deadlineDays: b.deadlineDays, warrantyValuePerDay: b.warrantyValuePerDay });
  });
  app.get("/v1/mandates/:id/quotes", async (req) => p.getQuotes(clientAuth(req).id, (req.params as any).id));
  app.get("/v1/deals/:id", async (req) => p.dealStatus(clientAuth(req).id, (req.params as any).id));
  app.post("/v1/deals/:id/confirm-delivery", async (req) => p.clientConfirmDelivery(clientAuth(req).id, (req.params as any).id));
  app.post("/v1/deals/:id/dispute", async (req, reply) => { reply.code(201); return p.openDispute(clientAuth(req).id, (req.params as any).id, (req.body as any).reason); });
  app.put("/v1/webhook", async (req) => { p.setWebhook(clientAuth(req).id, (req.body as any).url); return { ok: true }; });
  app.get("/v1/profile", async (req) => p.getProfile(clientAuth(req).id));
  app.put("/v1/profile", async (req) => { p.putProfile(clientAuth(req).id, req.body); return { ok: true }; });
  app.get("/v1/export", async (req) => p.exportClient(clientAuth(req).id));
  app.get("/v1/decision-log", async (req) => p.decisionLog("client", clientAuth(req).id));
  app.delete("/v1/me", async (req) => { p.deleteClient(clientAuth(req).id); return { ok: true }; });

  // =============== MCP over HTTP (stateless) ===============
  // NOTE: Bearer client key for now. OAuth 2.1 + PKCE (needed for the Claude/ChatGPT directories) is the next task.
  app.post("/mcp", async (req, reply) => {
    const key = bearer(req);
    p.clientByKey(key); // 401 before any MCP work
    reply.hijack();
    const server = createMcpServer(p, () => key);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // =============== WEB: vendor tap-to-confirm ===============
  app.get("/confirm/:token", async (req, reply) => {
    const q = p.quoteByConfirmToken((req.params as any).token);
    const open = q.status === "awaiting_vendor";
    return html(reply, layout("Confirm deal", `<h1>Confirm this deal</h1><div class="card">
      <p>Buyer asked for <b>${esc(q.query)}</b>.</p><p>Your agent negotiated <b>${esc(q.title)}</b> at <b>${usd(q.price)}</b>${q.warranty_days ? ` with a ${q.warranty_days}-day warranty` : ""}.</p>
      ${open ? `<p class="mut">Link expires ${when(q.expires_at)}.</p>
      <form method="post" class="inline"><input type="hidden" name="a" value="confirm"><button>Confirm deal</button></form>
      <form method="post" class="inline"><input type="hidden" name="a" value="decline"><button class="alt">Decline</button></form>`
        : `<p class="notice">This quote is <b>${esc(q.status)}</b>.</p>`}</div>`));
  });
  app.post("/confirm/:token", async (req, reply) => {
    const r = p.confirmByToken((req.params as any).token, (req.body as any)?.a === "confirm");
    return html(reply, layout("Done", `<div class="card"><h1>${r.status === "vendor_confirmed" ? "Confirmed" : "Declined"}</h1><p>The buyer has been told. You will be notified if they pay.</p></div>`));
  });

  // =============== WEB: hosted client approval page (the only way money moves) ===============
  app.get("/approve/:id", async (req, reply) => {
    const q = p.quoteForApproval((req.params as any).id);
    const open = q.status === "vendor_confirmed";
    const t = q.trust;
    return html(reply, layout("Approve and pay", `<h1>Approve and pay</h1><div class="card">
      <h2 style="margin-top:0">${esc(q.title)} <span class="pill">${esc(q.condition)}</span></h2>
      <p><b>${usd(q.price)}</b> total${q.warranty_days ? ` · ${q.warranty_days}-day warranty` : ""} · ${q.return_window_days}-day return window</p>
      <p class="mut">Seller: ${esc(q.vname)} · ${t.verified ? '<span class="ok">verified</span>' : "unverified"} · ${t.completedDeals} completed deals · on-time ${t.onTimeRate ?? "n/a"}${t.onTimeRate != null ? "%" : ""} · disputes ${t.disputeRate ?? "n/a"}${t.disputeRate != null ? "%" : ""}</p>
      <div class="notice"><b>Escrow:</b> your payment is held by our licensed payment partner, not by the seller or by us. It is released when you confirm delivery, or automatically 3 days after delivery. You can open a dispute within 3 days of delivery and the money stays held until our team decides.</div>
      ${open ? `<form method="post"><label>Delivery</label><select name="method"><option value="pickup">Local pickup (Houston)</option><option value="shipping">Shipping</option></select>
      <label>Your approval PIN (your AI does not have this)</label><input name="pin" type="password" inputmode="numeric" autocomplete="off" required>
      <button>Approve and pay ${usd(q.price)}</button> <button class="alt" name="decline" value="1" formnovalidate>Decline</button></form>`
        : `<p class="notice">This quote is <b>${esc(q.status)}</b> and can no longer be approved.</p>`}</div>`));
  });
  app.post("/approve/:id", async (req, reply) => {
    const b = req.body as any; const id = (req.params as any).id;
    try {
      if (b.decline) { p.declineQuote(id, String(b.pin ?? "")); return html(reply, layout("Declined", `<div class="card"><h1>Declined</h1><p>No payment was made.</p></div>`)); }
      const r = await p.approveQuote(id, String(b.pin ?? ""), b.method === "shipping" ? "shipping" : "pickup");
      return html(reply, layout("Paid", `<div class="card"><h1>Payment held in escrow</h1><p>Deal <code>${esc(r.dealId)}</code> is paid and held. Ask your AI for the deal status, or confirm delivery in the buyer app.</p></div>`));
    } catch (e: any) {
      if (e instanceof HttpError) return reply.code(e.status).type("text/html").send(layout("Not approved", `<div class="card"><h1>Not approved</h1><p class="bad">${esc(e.message)}</p><a class="btn" href="/approve/${esc(id)}">Back</a></div>`));
      throw e;
    }
  });

  // =============== WEB: buyer app ===============
  const clientNav = `<a href="/">Buyer app</a><a href="/vendor">Vendor</a><a href="/admin">Admin</a>`;
  app.get("/", async (req, reply) => {
    const s = sess(req, "client");
    if (!s) return html(reply, layout("Buyer app", `<h1>Buy used electronics with an AI negotiating for you</h1>
      <div class="row"><div class="card"><h2 style="margin-top:0">Sign in</h2><form method="post" action="/app/login"><label>Email</label><input name="email" type="email" required><label>Approval PIN</label><input name="pin" type="password" required><button>Sign in</button></form></div>
      <div class="card"><h2 style="margin-top:0">New buyer</h2><form method="post" action="/app/signup"><label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required><label>Choose a 4 to 8 digit approval PIN</label><input name="pin" type="password" inputmode="numeric" required><button>Create account</button></form><p class="mut">Using Claude or ChatGPT? Connect our MCP server instead; you will still approve and pay here.</p></div></div>`, clientNav));
    return html(reply, layout("Buyer app", `<h1>What do you want to buy?</h1><div class="card"><form method="post" action="/app/mandate">
      <label>Item</label><input name="query" placeholder="MacBook Air M2" required>
      <div class="row"><div><label>Category</label><select name="category"><option value="">any</option><option>laptop</option><option>phone</option><option>tablet</option><option>console</option></select></div>
      <div><label>Must-haves (comma separated)</label><input name="must" placeholder="16GB, 512GB"></div></div>
      <div class="row"><div><label>Maximum budget (USD, 100 to 2000)</label><input name="budget" type="number" min="100" max="2000" required></div>
      <div><label>Needed within (days, optional)</label><input name="deadline" type="number" min="1"></div></div>
      <label>Warranty is worth this much per day to me (USD, optional)</label><input name="warranty" type="number" step="0.01" min="0">
      <button>Find quotes</button></form></div>
      <h2>Your deals</h2>${dealsTable(p, s.id)}`, clientNav + `<a href="/app/logout">Sign out</a>`));
  });
  const dealsTable = (pp: Platform, clientId: string) => {
    const rows = pp.db.prepare("SELECT d.id,d.status,d.price,i.title FROM deals d JOIN items i ON i.id=d.item_id WHERE d.client_id=? ORDER BY d.created_at DESC").all(clientId) as any[];
    if (!rows.length) return `<p class="mut">No deals yet.</p>`;
    return `<table><tr><th>Item</th><th>Price</th><th>Status</th><th></th></tr>${rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${usd(r.price)}</td><td><span class="pill">${esc(r.status)}</span></td><td>${["paid_held", "shipped", "delivered"].includes(r.status)
      ? `<form class="inline" method="post" action="/app/deals/${esc(r.id)}/confirm"><button>Item is fine, release</button></form> <form class="inline" method="post" action="/app/deals/${esc(r.id)}/dispute"><input name="reason" placeholder="What is wrong?" style="width:200px;display:inline"><button class="bad">Dispute</button></form>` : ""}</td></tr>`).join("")}</table>`;
  };
  app.post("/app/signup", async (req, reply) => {
    const b = req.body as any; const r = p.signupClient({ name: b.name, email: b.email, pin: b.pin });
    login(reply, { role: "client", id: r.clientId }); return reply.redirect("/");
  });
  app.post("/app/login", async (req, reply) => {
    const b = req.body as any; const c = p.loginClient(b.email, b.pin);
    login(reply, { role: "client", id: c.id }); return reply.redirect("/");
  });
  app.get("/app/logout", async (req, reply) => { sessions.delete(cookie(req, "adl_s")); reply.header("set-cookie", "adl_s=; Max-Age=0; Path=/"); return reply.redirect("/"); });
  app.post("/app/mandate", async (req, reply) => {
    const s = sess(req, "client"); if (!s) return reply.redirect("/");
    const b = req.body as any;
    const r = await p.createMandate(s.id, {
      query: b.query, category: b.category, mustHaves: String(b.must ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      budget: Math.round(parseFloat(b.budget) * 100), deadlineDays: b.deadline ? parseInt(b.deadline, 10) : undefined,
      warrantyValuePerDay: b.warranty ? Math.round(parseFloat(b.warranty) * 100) : 0,
    });
    return reply.redirect(`/app/mandates/${r.mandateId}`);
  });
  app.get("/app/mandates/:id", async (req, reply) => {
    const s = sess(req, "client"); if (!s) return reply.redirect("/");
    const r = p.getQuotes(s.id, (req.params as any).id);
    return html(reply, layout("Quotes", `<h1>Your quotes</h1>${r.awaitingVendors ? `<p class="notice">${r.awaitingVendors} vendor(s) still confirming. Refresh in a few minutes (they have up to 2 hours).</p>` : ""}
      ${r.quotes.length ? r.quotes.map((q) => `<div class="card"><h2 style="margin-top:0">${esc(q.item)} <span class="pill">${esc(q.condition)}</span></h2>
        <p><b>${q.price}</b>${q.warrantyDays ? ` · ${q.warrantyDays}-day warranty` : ""}</p>
        <p class="mut">${esc(q.vendor)} · ${q.trust.verified ? "verified" : "unverified"} · ${q.trust.completedDeals} deals · on-time ${q.trust.onTimeRate ?? "n/a"} · disputes ${q.trust.disputeRate ?? "n/a"}</p>
        <a class="btn" href="/approve/${esc(q.quoteId)}">Review and approve</a></div>`).join("") : `<p class="mut">No confirmed quotes yet.</p>`}
      <p><a href="/app/mandates/${esc((req.params as any).id)}">Refresh</a></p>`, clientNav));
  });
  app.post("/app/deals/:id/confirm", async (req, reply) => { const s = sess(req, "client"); if (!s) return reply.redirect("/"); await p.clientConfirmDelivery(s.id, (req.params as any).id); return reply.redirect("/"); });
  app.post("/app/deals/:id/dispute", async (req, reply) => { const s = sess(req, "client"); if (!s) return reply.redirect("/"); await p.openDispute(s.id, (req.params as any).id, (req.body as any).reason); return reply.redirect("/"); });

  // =============== WEB: vendor dashboard ===============
  const vNav = `<a href="/">Buyer app</a><a href="/vendor">Dashboard</a><a href="/app/logout">Sign out</a>`;
  app.post("/vendor/login", async (req, reply) => { const v = p.vendorByKey((req.body as any).key); login(reply, { role: "vendor", id: (req.body as any).key }); void v; return reply.redirect("/vendor"); });
  app.get("/vendor", async (req, reply) => {
    const s = sess(req, "vendor");
    if (!s) return html(reply, layout("Vendor", `<h1>Vendor sign in</h1><div class="card"><form method="post" action="/vendor/login"><label>Vendor API key</label><input name="key" type="password" required><button>Sign in</button></form></div>`, vNav));
    const v = p.vendorByKey(s.id);
    if (v.status !== "approved") return html(reply, layout("Vendor", `<div class="card"><h1>Waiting for approval</h1><p>Your account is <b>${esc(v.status)}</b>. Our team checks your business ID before you can list items.</p></div>`, vNav));
    const pend = p.pendingQuotesForVendor(v.id), items = p.listItems(v.id), leads = p.leads(v.id), fun = p.funnel(v.id), deals = p.vendorDeals(v.id), price = p.pricing(v.id).filter((x) => x.suggestedPrice);
    return html(reply, layout("Vendor dashboard", `<h1>${esc(v.name)}</h1>
      <h2>Deals waiting for your tap</h2>${pend.length ? `<table><tr><th>Item</th><th>Price</th><th>Expires</th><th></th></tr>${pend.map((q: any) => `<tr><td>${esc(q.title)}</td><td>${usd(q.price)}${q.warranty_days ? ` + ${q.warranty_days}d warranty` : ""}</td><td>${when(q.expires_at)}</td><td>
        <form class="inline" method="post" action="/vendor/quotes/${esc(q.id)}/confirm"><button>Confirm</button></form> <form class="inline" method="post" action="/vendor/quotes/${esc(q.id)}/decline"><button class="alt">Decline</button></form></td></tr>`).join("")}</table>` : `<p class="mut">Nothing waiting.</p>`}
      <h2>Paid deals</h2>${deals.length ? `<table><tr><th>Item</th><th>Price</th><th>Status</th><th></th></tr>${deals.map((d: any) => `<tr><td>${esc(d.title)}</td><td>${usd(d.price)}</td><td><span class="pill">${esc(d.status)}</span></td><td>${d.status === "paid_held" || d.status === "shipped" ? `<form class="inline" method="post" action="/vendor/deals/${esc(d.id)}/delivered"><button>Mark delivered / picked up</button></form>` : ""}</td></tr>`).join("")}</table>` : `<p class="mut">No deals yet.</p>`}
      <h2>Lead list</h2>${leads.length ? `<table><tr><th>When</th><th>Item</th><th>Buyer wanted</th><th>Quote</th><th>Outcome</th><th>Why</th></tr>${leads.map((l: any) => `<tr><td>${when(l.created_at)}</td><td>${esc(l.title)}</td><td>${esc(l.query)}</td><td>${l.price ? usd(l.price) : "–"}</td><td><span class="pill">${esc(l.outcome)}</span></td><td>${esc(l.reason)}</td></tr>`).join("")}</table>` : `<p class="mut">No leads yet.</p>`}
      <h2>Funnel per product</h2><table><tr><th>Item</th><th>Views</th><th>Quote requests</th><th>Deals</th><th>Revenue</th></tr>${fun.map((f: any) => `<tr><td>${esc(f.title)}</td><td>${f.views}</td><td>${f.quoteRequests}</td><td>${f.deals}</td><td>${usd(f.revenue)}</td></tr>`).join("")}</table>
      ${price.length ? `<h2>Price suggestions</h2>${price.map((x) => `<div class="card">${esc(x.title)}: list ${usd(x.listPrice)}, market median ${usd(x.marketMedian!)}. ${esc(x.reason)} <form class="inline" method="post" action="/vendor/items/${esc(x.itemId)}/accept-price"><button>Set to ${usd(x.suggestedPrice!)}</button></form></div>`).join("")}` : ""}
      <h2>Items (${items.length})</h2><table><tr><th>Item</th><th>List</th><th>Stock</th><th>Status</th></tr>${items.map((i: any) => `<tr><td>${esc(i.title)}</td><td>${usd(i.list_price)}</td><td>${i.stock}</td><td>${esc(i.status)}</td></tr>`).join("")}</table>
      <h2>Import items (CSV)</h2><div class="card"><form method="post" action="/vendor/import"><p class="mut">Columns: title, category, price, stock, specs, condition, floor (optional, USD)</p><textarea name="csv" rows="6" placeholder="title,category,price,stock&#10;macbook air m2 16gb,laptop,900,2"></textarea><button>Import</button></form></div>`, vNav));
  });
  const vendorForm = (path: string, fn: (v: any, req: FastifyRequest) => void | Promise<void>) =>
    app.post(path, async (req, reply) => { const s = sess(req, "vendor"); if (!s) return reply.redirect("/vendor"); await fn(p.vendorByKey(s.id), req); return reply.redirect("/vendor"); });
  vendorForm("/vendor/import", (v, req) => { p.importCsv(v.id, String((req.body as any).csv)); });
  // form-post variants of the JSON actions (the JSON routes above take Bearer keys; these take the session cookie)
  app.post("/vendor/quotes/:id/:action", async (req, reply) => {
    const { id, action } = req.params as any;
    if (bearer(req)) { const v = vendorAuth(req); return p.vendorDecision(v.id, id, action === "confirm"); }
    const s = sess(req, "vendor"); if (!s) return reply.redirect("/vendor");
    p.vendorDecision(p.vendorByKey(s.id).id, id, action === "confirm"); return reply.redirect("/vendor");
  });
  app.post("/vendor/deals/:id/delivered", async (req, reply) => {
    const id = (req.params as any).id;
    if (bearer(req)) return p.vendorMarkDelivered(vendorAuth(req).id, id);
    const s = sess(req, "vendor"); if (!s) return reply.redirect("/vendor");
    p.vendorMarkDelivered(p.vendorByKey(s.id).id, id); return reply.redirect("/vendor");
  });
  app.post("/vendor/items/:id/accept-price", async (req, reply) => {
    const id = (req.params as any).id;
    if (bearer(req)) return p.acceptPriceSuggestion(vendorAuth(req).id, id);
    const s = sess(req, "vendor"); if (!s) return reply.redirect("/vendor");
    p.acceptPriceSuggestion(p.vendorByKey(s.id).id, id); return reply.redirect("/vendor");
  });

  // =============== WEB: admin panel ===============
  app.post("/admin/login", async (req, reply) => {
    if ((req.body as any).key !== adminKey) throw new HttpError(401, "wrong admin key");
    login(reply, { role: "admin", id: "admin" }); return reply.redirect("/admin");
  });
  app.get("/admin", async (req, reply) => {
    if (!sess(req, "admin")) return html(reply, layout("Admin", `<h1>Admin sign in</h1><div class="card"><form method="post" action="/admin/login"><label>Admin key</label><input name="key" type="password" required><button>Sign in</button></form></div>`, clientNav));
    const pend = p.listVendors("pending"), disp = p.listDisputes("open");
    return html(reply, layout("Admin", `<h1>Admin panel</h1>
      <h2>Vendors waiting for approval</h2>${pend.length ? `<table><tr><th>Name</th><th>Email</th><th>Business ID</th><th>Decision</th></tr>${pend.map((v: any) => `<tr><td>${esc(v.name)}</td><td>${esc(v.email)}</td><td>${esc(v.business_id)}</td><td>
        <form class="inline" method="post" action="/admin/f/vendors/${esc(v.id)}/approve"><input name="reason" placeholder="reason" style="width:150px;display:inline" required><button>Approve</button></form>
        <form class="inline" method="post" action="/admin/f/vendors/${esc(v.id)}/reject"><input name="reason" placeholder="reason" style="width:150px;display:inline" required><button class="bad">Reject</button></form></td></tr>`).join("")}</table>` : `<p class="mut">None.</p>`}
      <h2>Open disputes</h2>${disp.length ? `<table><tr><th>Item</th><th>Amount</th><th>Client's reason</th><th>Decision</th></tr>${disp.map((d: any) => `<tr><td>${esc(d.title)}</td><td>${usd(d.price)}</td><td>${esc(d.reason)}</td><td>
        <form method="post" action="/admin/f/disputes/${esc(d.id)}"><input name="reason" placeholder="reason (logged)" required><button name="decision" value="refund" class="bad">Refund client</button> <button name="decision" value="release" class="alt">Pay vendor</button></form></td></tr>`).join("")}</table>` : `<p class="mut">None.</p>`}
      <h2>Access codes</h2><form method="post" action="/admin/f/codes"><button>Create a vendor access code</button></form>`, clientNav));
  });
  const adminForm = (path: string, fn: (req: FastifyRequest) => Promise<void> | void) =>
    app.post(path, async (req, reply) => { if (!sess(req, "admin")) return reply.redirect("/admin"); await fn(req); return reply.redirect("/admin"); });
  adminForm("/admin/f/vendors/:id/:action", (req) => { const { id, action } = req.params as any; p.decideVendor(id, action === "approve", (req.body as any).reason); });
  adminForm("/admin/f/disputes/:id", async (req) => { const b = req.body as any; await p.decideDispute((req.params as any).id, b.decision, b.reason); });
  app.post("/admin/f/codes", async (req, reply) => {
    if (!sess(req, "admin")) return reply.redirect("/admin");
    const code = p.createAccessCode();
    return html(reply, layout("Access code", `<div class="card"><h1>New access code</h1><p><code>${esc(code)}</code></p><a class="btn" href="/admin">Back</a></div>`, clientNav));
  });

  return app;
}

// ---------- entry ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const useStripe = process.env.ESCROW === "stripe";
  const p = new Platform(openDb(process.env.ADL_DB ?? "adl.db"), {
    escrow: useStripe ? new StripeConnectEscrow() : new SimulatedEscrow(),
    contextKey: process.env.CONTEXT_KEY, baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    sendWebhook: async (url, payload) => { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }); },
  });
  // No shared default key: without ADMIN_KEY each run gets its own random one.
  const adminKey = process.env.ADMIN_KEY ?? randomBytes(18).toString("base64url");
  if (!process.env.ADMIN_KEY) console.log(`ADMIN_KEY not set; admin key for this run: ${adminKey}`);
  const app = buildApp(p, adminKey);
  if (process.env.HEARTH === "1") {
    // The Hearth shell's open connector (src/hearth.ts). Point the shell's Connector at this server.
    const h = registerHearth(app, p, {
      pin: process.env.HEARTH_PIN, inrPerUsd: Number(process.env.HEARTH_INR_PER_USD ?? 83),
      origins: process.env.HEARTH_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
    });
    if (process.env.HEARTH_SEED !== "0") seedHearth(h);
    console.log(`Hearth connector on /hearth/* at ${h.inrPerUsd} INR per USD. Approval PIN for Hearth buyers this run: ${h.pin}`);
  }
  setInterval(() => p.tick(), 60_000).unref();
  // Local only unless HOST is set (e.g. HOST=0.0.0.0 behind HTTPS when deployed).
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "127.0.0.1" });
  console.log(`Agent Deal Layer on :${process.env.PORT ?? 3000} (escrow: ${p.escrow.name})`);
}
