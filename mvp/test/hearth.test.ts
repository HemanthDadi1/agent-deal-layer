import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { registerHearth, seedHearth } from "../src/hearth.js";
import { setup } from "./helpers.js";

const env = setup();
const app = buildApp(env.p, "test-admin");
const h = registerHearth(app, env.p, { pin: "4321" });
seedHearth(h);
afterAll(() => app.close());

const j = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, payload: body ? JSON.stringify(body) : undefined });
  return { status: r.statusCode, body: r.json() as any, headers: r.headers };
};
const buyer = (id: string, want: string, maxPrice: number, category?: string) => ({
  schema: "hearth.buyer-intent/1", id, currency: "INR", createdAt: new Date().toISOString(),
  public: { want, category: category ?? null, mustHaves: [], conditions: [], timing: null, handover: { mode: "either", city: "Pune" } },
  private: { maxPrice, hopingFor: null, warrantyValuePerDay: 0, style: 50 }, rules: { alwaysAskBeforePaying: true },
});
const listing = (id: string, title: string, askingPrice: number, lowestPrice: number, autoConfirmAbove: number | null = null, category = "other") => ({
  schema: "hearth.seller-listing/1", id, currency: "INR", createdAt: new Date().toISOString(),
  public: { title, description: title, category, condition: "good", details: [], photos: [], askingPrice, warrantyDays: 0, handover: { mode: "either", city: "Pune", readyInDays: 0 } },
  private: { lowestPrice, autoConfirmAbove, style: 50 },
});
const events = async (id: string) => (await j("GET", `/hearth/agents/${id}/events?after=0`)).body;
const offerOf = async (id: string) => (await events(id)).events.find((e: any) => e.type === "offer")?.offer;
// Nothing the shell can read may carry a floor or a budget, in rupees or in cents.
const leaks = (x: unknown, ...secrets: number[]) => { const s = JSON.stringify(x); return /floor|budget|maxPrice|lowestPrice/.test(s) || secrets.some((n) => s.includes(String(n))); };

describe("Hearth connector on the agent-deal-layer", () => {
  it("health, recommendations and feed answer; CORS only for the shell's origin", async () => {
    expect((await j("GET", "/hearth/health")).body.name).toBe("agent-deal-layer");
    const rec = (await j("GET", "/hearth/recommendations")).body.items;
    expect(rec.length).toBe(6);
    expect(leaks(rec)).toBe(false);
    expect((await j("GET", "/hearth/feed")).body.events.length).toBeGreaterThan(0);
    expect((await j("GET", "/hearth/health", undefined, { origin: "http://127.0.0.1:8090" })).headers["access-control-allow-origin"]).toBe("http://127.0.0.1:8090");
    expect((await j("GET", "/hearth/health", undefined, { origin: "https://evil.example" })).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects bad briefs and prices outside the layer's range", async () => {
    expect((await j("POST", "/hearth/buyer-intents", { ...buyer("bi_bad", "", 20000) })).status).toBe(422);
    expect((await j("POST", "/hearth/buyer-intents", buyer("bi_small", "pen", 500))).status).toBe(422);
    expect((await j("POST", "/hearth/seller-listings", listing("sl_bad", "Lamp", 9000, 9500))).status).toBe(422);
  });

  it("buyer: the engine negotiates with a seeded seller, the PIN approves, money is held", async () => {
    expect((await j("POST", "/hearth/buyer-intents", buyer("bi_cam", "film camera", 17000, "camera"))).status).toBe(201);
    const ev = await events("bi_cam");
    const types = ev.events.map((e: any) => e.type);
    expect(types).toContain("match");
    expect(types).toContain("message");
    const offer = ev.events.find((e: any) => e.type === "offer").offer;
    expect(offer.price).toBeLessThanOrEqual(17000);
    expect(leaks(ev, 17000, Math.floor(1700000 / 83))).toBe(false);
    expect((await j("POST", `/hearth/offers/${offer.id}/approve`, { pin: "0000" })).status).toBe(403);
    const ok = await j("POST", `/hearth/offers/${offer.id}/approve`, { pin: "4321" });
    expect(ok.status).toBe(200);
    expect(ok.body.deal.status).toBe("held");
    expect((await events("bi_cam")).events.some((e: any) => e.type === "deal")).toBe(true);
  });

  it("a product page's targetProductId negotiates with that one seller only", async () => {
    const canon = env.p.db.prepare("SELECT id, title FROM items WHERE title LIKE 'iPhone%'").get() as any; // "iPhone", not "IPhone"
    const b = { ...buyer("bi_one", canon.title, 40000, "phone") };
    b.public = { ...b.public, targetProductId: canon.id } as any;
    await j("POST", "/hearth/buyer-intents", b);
    const matches = (await events("bi_one")).events.filter((e: any) => e.type === "match");
    expect(matches.map((m: any) => m.product.id)).toEqual([canon.id]);
  });

  it("watch: a waiting buyer meets a new listing; the seller confirms, the buyer approves", async () => {
    await j("POST", "/hearth/buyer-intents", buyer("bi_sw", "Nintendo Switch OLED", 25000));
    expect((await events("bi_sw")).events.some((e: any) => e.type === "no_match")).toBe(true);
    await j("POST", "/hearth/agents/bi_sw/watch", { post: true });
    expect((await j("GET", "/hearth/wanted")).body.items.some((w: any) => w.id === "bi_sw" && !("maxPrice" in w))).toBe(true);
    expect((await j("POST", "/hearth/seller-listings", listing("sl_sw", "Nintendo Switch OLED white", 24000, 19500))).status).toBe(201);
    const so = await offerOf("sl_sw");
    expect(so.role).toBe("seller");
    expect(so.price).toBeGreaterThanOrEqual(19500);
    expect(so.price).toBeLessThanOrEqual(24000);
    expect(leaks(await events("sl_sw"), 25000)).toBe(false);
    expect(await offerOf("bi_sw")).toBeUndefined(); // the buyer sees an offer only once the seller has said yes
    expect((await j("POST", `/hearth/offers/${so.id}/approve`, {})).body.waiting).toBe(true);
    const bo = await offerOf("bi_sw");
    expect(bo.price).toBe(so.price);
    expect((await j("POST", `/hearth/offers/${bo.id}/approve`, { pin: "4321" })).body.deal.price).toBe(so.price);
    expect((await events("sl_sw")).events.some((e: any) => e.type === "deal")).toBe(true);
  });

  it("invite: an outside seller accepts, agrees within both limits; a used link stays closed", async () => {
    await j("POST", "/hearth/buyer-intents", buyer("bi_lc", "Leica M6 rangefinder", 160000));
    const inv = (await j("POST", "/hearth/agents/bi_lc/invites", { link: "https://example.com/m6", seenPrice: 150000, sellerName: "Dev" }, { origin: "http://127.0.0.1:8090" })).body.invite;
    expect(inv.url).toBe(`http://127.0.0.1:8090/#/invite/${inv.token}`);
    expect(inv.message).not.toContain("1,60,000");
    const seen = (await j("GET", `/hearth/invites/${inv.token}`)).body.invite;
    expect(seen.status).toBe("open");
    expect(leaks(seen, 160000)).toBe(false);
    const acc = await j("POST", `/hearth/invites/${inv.token}/accept`, { listing: listing("sl_lc", "Leica M6 rangefinder", 150000, 130000), name: "Dev" });
    expect(acc.status).toBe(201);
    const bo = await offerOf("bi_lc");
    expect(bo.price).toBeGreaterThanOrEqual(130000);
    expect(bo.price).toBeLessThanOrEqual(150000);
    expect((await j("POST", `/hearth/offers/${bo.id}/approve`, { pin: "4321" })).status).toBe(200);
    expect((await j("POST", `/hearth/invites/${inv.token}/accept`, { listing: listing("sl_lc2", "Leica M6", 150000, 130000) })).status).toBe(409);
  });

  it("decline and the 3-invite cap", async () => {
    await j("POST", "/hearth/buyer-intents", buyer("bi_rf", "Rolleiflex 2.8F", 90000));
    const t = (await j("POST", "/hearth/agents/bi_rf/invites", {})).body.invite.token;
    expect((await j("POST", `/hearth/invites/${t}/decline`, {})).status).toBe(200);
    expect((await j("GET", `/hearth/invites/${t}`)).body.invite.status).toBe("declined");
    await j("POST", "/hearth/agents/bi_rf/invites", {}); await j("POST", "/hearth/agents/bi_rf/invites", {});
    expect((await j("POST", "/hearth/agents/bi_rf/invites", {})).status).toBe(429);
  });
});
