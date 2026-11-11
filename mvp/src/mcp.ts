import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Platform } from "./service.js";
import { HttpError } from "./service.js";

/**
 * Buyer-AI connector. Tools mirror the REST API. There is deliberately NO approve or pay tool:
 * the buyer's AI can only hand the human an approval link (the human enters a PIN the AI never holds).
 */
export function createMcpServer(p: Platform, clientKey: () => string) {
  const server = new McpServer({ name: "agent-deal-layer", version: "0.1.0" });
  const client = () => p.clientByKey(clientKey());
  const wrap = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const out = await fn();
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], structuredContent: out as Record<string, unknown> };
    } catch (e: any) {
      const msg = e instanceof HttpError ? e.message : "internal error";
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  };

  server.registerTool("create_mandate", {
    description: "Tell the marketplace what the buyer wants. Vendor agents negotiate on the buyer's behalf using one shared engine. " +
      "Budget is in US cents (e.g. 75000 = $750). Returns a mandateId; then call get_quotes. Quotes appear as vendors confirm (usually within minutes, up to 2 hours).",
    inputSchema: {
      query: z.string().describe("What to buy, e.g. 'MacBook Air M2'"),
      category: z.string().optional().describe("laptop, phone, tablet, console"),
      must_haves: z.array(z.string()).optional().describe("Specs that must match, e.g. ['16GB','512GB']"),
      budget_cents: z.number().int().describe("Hard maximum the buyer will pay, in cents. $100 to $2,000."),
      deadline_days: z.number().int().optional().describe("Needed within this many days"),
      warranty_value_per_day_cents: z.number().int().optional().describe("How much the buyer values each warranty day, in cents"),
    },
  }, (a) => wrap(() => client() && p.createMandate(client().id, {
    query: a.query, category: a.category, mustHaves: a.must_haves, budget: a.budget_cents,
    deadlineDays: a.deadline_days, warrantyValuePerDay: a.warranty_value_per_day_cents,
  })));

  server.registerTool("get_quotes", {
    description: "Get up to 3 best confirmed quotes for a mandate with vendor trust signals. To buy, give the human the approvalUrl: " +
      "only the human can approve and pay (the AI cannot).",
    inputSchema: { mandate_id: z.string() },
  }, (a) => wrap(() => p.getQuotes(client().id, a.mandate_id)));

  server.registerTool("get_deal_status", {
    description: "Status of a paid deal: paid_held, shipped, delivered, released, disputed or refunded, plus the escrow state.",
    inputSchema: { deal_id: z.string() },
  }, (a) => wrap(() => p.dealStatus(client().id, a.deal_id)));

  server.registerTool("open_dispute", {
    description: "Open a dispute if the item is wrong. Allowed within 3 days of delivery. Money stays held until an admin decides.",
    inputSchema: { deal_id: z.string(), reason: z.string().describe("What is wrong, factually") },
  }, (a) => wrap(() => p.openDispute(client().id, a.deal_id, a.reason)));

  return server;
}
