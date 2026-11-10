"""Fairness test: does the buyer's choice of AI model change the price?

Part A (with the shared engine): three different "assistants" send the same
user's limits through the real MCP tools, each phrased differently (argument
order, extra settings, different client names). The engine computes the offers,
so the deals must be identical.

Part B (without a shared engine, simulated): each assistant negotiates on its
own, with the skill differences Project Deal observed between stronger and
weaker models (a weaker model opens higher and gives ground faster). Same
seller, same limits, different prices.

Run:  python fairness_test.py
"""
from __future__ import annotations

import asyncio
import json

from mcp import Client

import server
from agentdeal import engine
from agentdeal.market import Marketplace

USER = dict(product="macbook-air-m2-16gb", max_price=750, deadline_days=4,
            warranty_value_per_day=1.0, min_specs={"ram_gb": 16, "battery_health": 85})

# Same user, phrased three ways by three assistants.
ASSISTANTS = {
    "assistant-A (strong model)": {**USER, "client": "assistant-A"},
    "assistant-B (mid model)": {"client": "assistant-B", "min_specs": {"battery_health": 85, "ram_gb": 16},
                                "warranty_value_per_day": 1, "deadline_days": 4, "max_price": 750.0,
                                "product": "macbook-air-m2-16gb"},
    "assistant-C (small model)": {**USER, "client": "assistant-C", "toughness": 0.5, "respect_market": True},
}


async def run_with_engine(args: dict) -> list[tuple]:
    server.market = Marketplace()                    # fresh, identical marketplace
    async with Client(server.mcp) as c:
        m = (await c.call_tool("set_mandate", args)).structured_content
        n = (await c.call_tool("start_negotiation", {"mandate_id": m["mandate_id"]})).structured_content
    return [(o["listing_id"], o["price"], o["warranty_days"], o["delivery_days"]) for o in n["options"]]


def run_without_engine() -> dict:
    """Each model bargains for itself against the same seller listing (L2, no warranty)."""
    mk = Marketplace()
    l2 = mk.listings["L2"]
    m = engine.Mandate(**{k: v for k, v in USER.items()}, respect_market=False)
    skills = {  # (opening offer, toughness) a model of that skill tends to use
        "assistant-A (strong model)": (650, 0.85),
        "assistant-B (mid model)": (680, 0.5),
        "assistant-C (small model)": (720, 0.1),
    }
    out = {}
    for name, (opening, tough) in skills.items():
        mm = engine.Mandate(**{**m.__dict__, "toughness": tough})
        o = engine.negotiate_package(mm, l2, opening, l2.warranty_options[0], l2.delivery_options[0])
        out[name] = o.price
    return out


async def main():
    with_engine = {name: await run_with_engine(args) for name, args in ASSISTANTS.items()}
    without = run_without_engine()

    print("\nPART A  With the shared engine (real MCP calls)")
    for name, deals in with_engine.items():
        print(f"  {name:<28} {deals}")
    identical = len({json.dumps(d) for d in with_engine.values()}) == 1
    print(f"  -> identical results for every assistant: {identical}")

    print("\nPART B  Without a shared engine (simulated self-negotiation, same seller L2)")
    for name, price in without.items():
        print(f"  {name:<28} ${price:,.0f}")
    spread = max(without.values()) - min(without.values())
    print(f"  -> price spread caused only by model skill: ${spread:,.0f}")

    assert identical, "fairness broken: assistants got different deals"
    print("\nPASS: with the shared engine, the buyer's choice of AI does not change the deal.\n")


if __name__ == "__main__":
    asyncio.run(main())
