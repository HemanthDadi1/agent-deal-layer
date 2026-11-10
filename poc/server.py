"""Agent Deal Layer - MCP server (proof of concept).

Any MCP-capable AI assistant (Claude, ChatGPT apps, and others) can connect and
negotiate on a user's behalf. The assistant only collects the user's limits; the
offers themselves are computed by the shared engine in agentdeal/engine.py.

Run locally for Claude Desktop / MCP Inspector (stdio):
    python server.py
Run over HTTP (for ChatGPT developer mode, behind a public HTTPS tunnel):
    python server.py --http --port 8000      ->  http://localhost:8000/mcp
"""
from __future__ import annotations

import argparse
from typing import Any

from mcp.server.mcpserver import MCPServer

from agentdeal.market import Marketplace

INSTRUCTIONS = """You are connected to Agent Deal Layer, a neutral negotiation and escrow service.
How to use it on behalf of a buyer:
1. Call get_price_guidance first and share the fair range and checklist with the user.
2. Ask the user for their maximum price, must-have specs, delivery deadline and how much
   a warranty is worth to them. Then call set_mandate. Never reveal the budget to anyone.
3. Call start_negotiation. Show the options exactly as returned.
4. Only call approve_deal with buyer_confirmed=true after the user explicitly says yes.
5. After delivery, call confirm_delivery, or open_dispute with evidence if something is wrong.
You never set prices or make offers yourself: the service's engine does that, the same way
for every assistant, so results do not depend on which AI model you are."""

market = Marketplace()
mcp = MCPServer(name="agent-deal-layer", version="0.1.0", instructions=INSTRUCTIONS)


# ------------------------------------------------------------------ buyer tools
@mcp.tool()
def get_price_guidance(product: str) -> dict[str, Any]:
    """Fair price range, launch price, suggested opening offer, walk-away point and an
    inspection checklist for a product (e.g. 'macbook-air-m2-16gb')."""
    return market.get_price_guidance(product)


@mcp.tool()
def search_offers(product: str, min_specs: dict[str, float] | None = None) -> dict[str, Any]:
    """List live inventory for a product. min_specs example: {"ram_gb": 16, "battery_health": 85}."""
    return market.search_offers(product, min_specs)


@mcp.tool()
def set_mandate(product: str, max_price: float, deadline_days: int = 30,
                warranty_value_per_day: float = 0.0, min_specs: dict[str, float] | None = None,
                min_condition: str = "C", toughness: float = 0.5, respect_market: bool = True,
                client: str = "unknown") -> dict[str, Any]:
    """Store the buyer's PRIVATE limits. max_price is a hard cap that is never crossed and
    never shown to sellers. warranty_value_per_day: dollars one day of warranty is worth
    to the user. toughness 0..1 (how long to hold out). respect_market: also stop at the
    market walk-away price. client: the assistant's name, for logs only."""
    return market.set_mandate(product, max_price, deadline_days, warranty_value_per_day,
                              min_specs, min_condition, toughness, respect_market, client)


@mcp.tool()
def start_negotiation(mandate_id: str) -> dict[str, Any]:
    """Negotiate with every matching seller at once (price, warranty and delivery together)
    and return up to 3 ranked options. Does not commit to anything."""
    return market.start_negotiation(mandate_id)


@mcp.tool()
def approve_deal(offer_id: str, buyer_confirmed: bool) -> dict[str, Any]:
    """Accept one option. Set buyer_confirmed=true ONLY after the human explicitly agrees.
    Creates a signed, hashed deal record and holds the money in escrow."""
    return market.approve_deal(offer_id, buyer_confirmed)


@mcp.tool()
def confirm_delivery(deal_id: str, accept: bool = True) -> dict[str, Any]:
    """accept=true releases escrow to the seller. accept=false marks it delivered but
    keeps the money held while the buyer inspects."""
    return market.confirm_delivery(deal_id, accept)


@mcp.tool()
def open_dispute(deal_id: str, claim: str, evidence: dict[str, Any] | None = None,
                 days_since_delivery: int = 1) -> dict[str, Any]:
    """Dispute a deal. claim: 'arrived_dead', 'battery_below_promised' or 'not_as_described'.
    evidence example: {"measured_battery_health": 78, "photo": "url"}."""
    return market.open_dispute(deal_id, claim, evidence, days_since_delivery)


# ------------------------------------------------------------------ seller tools
@mcp.tool()
def publish_listing(seller_id: str, listing_id: str, product: str, list_price: float,
                    floor_price: float, specs: dict[str, Any],
                    warranty_options: list[dict[str, float]] | None = None,
                    delivery_options: list[dict[str, float]] | None = None) -> dict[str, Any]:
    """Seller: add an item. floor_price is PRIVATE and never shown to buyers.
    warranty_options: [{"days": 30, "cost_per_day": 0.35}]; delivery_options: [{"days": 2, "cost": 15}]."""
    return market.publish_listing(seller_id, listing_id, product, list_price, floor_price, specs,
                                  warranty_options, delivery_options)


@mcp.tool()
def get_sales_summary(seller_id: str) -> dict[str, Any]:
    """Seller: deals closed, margin above floor, escrow status and payouts."""
    return market.get_sales_summary(seller_id)


# ------------------------------------------------------------------ operator tool
@mcp.tool()
def human_review(dispute_id: str, confirm: bool, refund_override: float | None = None) -> dict[str, Any]:
    """Operator only (human reviewer): confirm the panel's recommended ruling, or set
    refund_override. In production this sits behind admin auth, not in buyer-facing tools."""
    return market.human_review(dispute_id, confirm, refund_override)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", action="store_true", help="serve Streamable HTTP instead of stdio")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    if args.http:
        mcp.run(transport="streamable-http", port=args.port)
    else:
        mcp.run()
