"""End-to-end demo over the real MCP protocol.

Starts server.py as a subprocess (stdio transport, exactly as Claude Desktop would)
and plays the part of the buyer's and seller's AI assistants through four scenarios:
  1. Buyer: Priya wants a used MacBook Air M2
  2. Seller: a new listing with pricing feedback, then the seller's sales summary
  3. Dispute: battery worse than promised
  4. Tampered record: a claimant presents an altered deal record (unit-level, see tests)

Run:  python demo.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from mcp import Client, StdioServerParameters

HERE = Path(__file__).parent


def line(title: str):
    print("\n" + "=" * 78 + f"\n{title}\n" + "=" * 78)


async def call(mcp_client: Client, tool: str, **args):
    res = await mcp_client.call_tool(tool, args)
    if res.is_error:
        raise RuntimeError(f"{tool} failed: {res.content}")
    data = res.structured_content
    if isinstance(data, dict) and set(data) == {"result"}:
        data = data["result"]
    if data is None:
        data = json.loads(res.content[0].text)
    return data


async def main():
    params = StdioServerParameters(command=sys.executable, args=[str(HERE / "server.py")], cwd=str(HERE))
    async with Client(params) as client:
        tools = await client.list_tools()
        line("Connected over MCP. Tools the AI assistant sees:")
        for t in tools.tools:
            print(f"  - {t.name}")

        # ---------------------------------------------------------------- 1. buyer
        line("SCENARIO 1  Buyer: 'MacBook Air M2, 16GB, battery 85%+, max $750, by Friday'")
        g = await call(client, "get_price_guidance", product="macbook-air-m2-16gb")
        print(f"Launch price ${g['launch_price']}, recent deals ${g['fair_range'][0]}-${g['fair_range'][1]} "
              f"(median ${g['median_price']}). Open at ${g['suggested_opening_offer']}, "
              f"walk away above ${g['suggested_walk_away_above']}.")
        print("Checklist:", *[f"\n   * {c}" for c in g["checklist"]])

        m = await call(client, "set_mandate", product="macbook-air-m2-16gb", max_price=750,
                       deadline_days=4, warranty_value_per_day=1.0,
                       min_specs={"ram_gb": 16, "battery_health": 85}, client="demo-assistant")
        print(f"\nMandate stored: {m}")

        n = await call(client, "start_negotiation", mandate_id=m["mandate_id"])
        print(f"\nNegotiated with {n['sellers_contacted']} matching sellers in parallel:")
        for o in n["options"]:
            print(f"  Option {o['option']}: {o['summary']}")
        for s in n["not_matching"]:
            print(f"  Skipped {s['listing_id']}: {s['reason']}")

        pick = n["options"][0]
        refused = await call(client, "approve_deal", offer_id=pick["offer_id"], buyer_confirmed=False)
        print(f"\nAI tries to approve without the human: {refused}")
        deal = await call(client, "approve_deal", offer_id=pick["offer_id"], buyer_confirmed=True)
        print(f"Human says yes -> deal {deal['deal_id']}, escrow {deal['escrow']}, "
              f"${deal['amount_held']:.0f} held, record sha256 {deal['record_sha256'][:16]}...")
        rel = await call(client, "confirm_delivery", deal_id=deal["deal_id"], accept=True)
        print(f"Delivered and inspected -> {rel}")

        # ---------------------------------------------------------------- 2. seller
        line("SCENARIO 2  Seller: Marcus lists a new laptop, then checks his sales")
        pub = await call(client, "publish_listing", seller_id="S1", listing_id="L8",
                         product="macbook-air-m2-16gb", list_price=799, floor_price=670,
                         specs={"ram_gb": 16, "storage_gb": 512, "battery_health": 93, "condition": "A"},
                         warranty_options=[{"days": 0, "cost_per_day": 0}, {"days": 30, "cost_per_day": 0.3}],
                         delivery_options=[{"days": 3, "cost": 0}])
        print(f"Published: {pub}")
        summ = await call(client, "get_sales_summary", seller_id="S1")
        print(f"Sales summary for S1: {json.dumps(summ, indent=2)}")

        # ---------------------------------------------------------------- 3. dispute
        line("SCENARIO 3  Dispute: listed battery 91%, buyer measures 78%")
        m2 = await call(client, "set_mandate", product="macbook-air-m2-16gb", max_price=700,
                        deadline_days=5, min_specs={"battery_health": 90}, client="demo-assistant")
        n2 = await call(client, "start_negotiation", mandate_id=m2["mandate_id"])
        o2 = n2["options"][0]
        print(f"Deal option: {o2['summary']}")
        d2 = await call(client, "approve_deal", offer_id=o2["offer_id"], buyer_confirmed=True)
        await call(client, "confirm_delivery", deal_id=d2["deal_id"], accept=False)
        x = await call(client, "open_dispute", deal_id=d2["deal_id"], claim="battery_below_promised",
                       evidence={"measured_battery_health": 78, "screenshot": "battery-report.png"},
                       days_since_delivery=1)
        print(f"Panel votes:")
        for v in x["review"]["votes"]:
            print(f"   {v['reviewer']:<10} -> {v['vote']}  ({v['why']})")
        print(f"Recommended: {x['review']['recommended']}, refund ${x['review']['refund']:.0f}; "
              f"deal is above $200 so status = {x['status']}")
        h = await call(client, "human_review", dispute_id=x["dispute_id"], confirm=True)
        print(f"Human reviewer confirms -> refund ${h['refund_to_buyer']:.0f} to buyer, "
              f"${h['paid_to_seller']:.0f} to seller, status {h['status']}")

        line("Done. Every price above was computed by the shared engine, not by an AI model.")


if __name__ == "__main__":
    asyncio.run(main())
