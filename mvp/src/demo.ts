import { openDb } from "./db.js";
import { Platform } from "./service.js";
import { SimulatedEscrow } from "./escrow.js";
import { dollars, DAY } from "./util.js";

let t = Date.UTC(2026, 10, 12, 15);
const p = new Platform(openDb(), { escrow: new SimulatedEscrow(), now: () => t });
const say = (s: string) => console.log(`\n== ${s}`);

say("Admin issues an access code; vendor signs up and is approved");
const v = p.signupVendor({ name: "Houston Tech", email: "owner@houstontech.example", phone: "+17135550100", businessId: "12-3456789", accessCode: p.createAccessCode() });
p.decideVendor(v.vendorId, true, "EIN verified");
p.setCategoryDefaults(v.vendorId, "laptop", { floorPct: 85, targetPct: 95, maxDiscountPct: 15, warrantyDays: 90, warrantyCostPerDay: 5 });
const imp = p.importCsv(v.vendorId, `title,category,price,stock,specs,condition,floor
macbook air m2 16gb 512gb,laptop,900,2,,used,780
dell xps 13 16gb,laptop,700,1,16GB i7,used,610`);
console.log(`Imported ${imp.imported} items. Items:`, p.listItems(v.vendorId).map((i: any) => `${i.title} list ${dollars(i.list_price)} (floor hidden from buyers)`));

say("Buyer's own AI sends a mandate: MacBook Air M2, 16GB, max $850, warranty worth $0.20/day");
const c = p.signupClient({ name: "Asha", email: "asha@example.com", pin: "4821" });
const { mandateId } = await p.createMandate(c.clientId, { query: "macbook air m2", mustHaves: ["16GB"], budget: 85_000, warrantyValuePerDay: 20 });
console.log("Quotes visible to buyer before vendor confirms:", p.getQuotes(c.clientId, mandateId).quotes.length);

say("Vendor agent asks the owner to confirm (SMS/email outbox)");
console.log(p.outbox().at(-1));
p.vendorDecision(v.vendorId, p.pendingQuotesForVendor(v.vendorId)[0].id, true);

say("Buyer's AI fetches the best quotes, and hands the human an approval link");
const { quotes } = p.getQuotes(c.clientId, mandateId);
console.log(quotes.map((q) => ({ item: q.item, price: q.price, warrantyDays: q.warrantyDays, trust: q.trust, approvalUrl: q.approvalUrl })));

say("Human approves on the hosted page with PIN (AI cannot); money goes into escrow");
try { await p.approveQuote(quotes[0].quoteId, "0000"); } catch (e: any) { console.log("Wrong PIN ->", e.message); }
const { dealId } = await p.approveQuote(quotes[0].quoteId, "4821");
console.log(p.dealStatus(c.clientId, dealId));

say("Vendor hands over the item; 3 days later escrow auto-releases");
p.vendorMarkDelivered(v.vendorId, dealId);
t += 3 * DAY + 60_000; await p.tickAsync();
console.log(p.dealStatus(c.clientId, dealId));

say("Vendor CRM");
console.log("Leads:", p.leads(v.vendorId).map((l: any) => `${l.title}: ${l.outcome}/${l.reason}`));
console.log("Funnel:", p.funnel(v.vendorId).map((f: any) => `${f.title}: views ${f.views}, requests ${f.quoteRequests}, deals ${f.deals}, revenue ${dollars(f.revenue)}`));
console.log("Billing (counted, not charged):", p.billing(v.vendorId));
console.log("Client decision log events:", p.decisionLog("client", c.clientId).map((e: any) => e.event).join(", "));
