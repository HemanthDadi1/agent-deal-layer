"""Deterministic multi-term negotiation engine.

Design rules (the point of the POC):
  * Offers are computed here, never by the buyer's or seller's LLM. The AI on each
    side only collects limits and preferences. So the same mandate gets the same
    deal whichever model (ChatGPT, Claude, Grok, DeepSeek, ...) sent it.
  * Private limits (buyer max price, seller floor) are hard caps checked in code.
  * Several terms are negotiated together: price, warranty days, delivery speed.
    A warranty that costs the seller little but is worth a lot to the buyer
    creates value for both sides.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from statistics import median

ROUNDS = 10
CONDITION_RANK = {"A": 3, "B": 2, "C": 1}


# --------------------------------------------------------------------------- models
@dataclass(frozen=True)
class Mandate:
    product: str
    max_price: float                      # hard cap, never crossed
    deadline_days: int = 30               # delivery must arrive within this
    warranty_value_per_day: float = 0.0   # what one day of warranty is worth to the buyer
    min_specs: dict = field(default_factory=dict)  # e.g. {"ram_gb": 16, "battery_health": 85}
    min_condition: str = "C"
    toughness: float = 0.5                # 0 = concede early, 1 = hold out
    respect_market: bool = True           # also stop at the market walk-away point


@dataclass(frozen=True)
class Listing:
    id: str
    seller_id: str
    product: str
    list_price: float
    floor_price: float                    # hard cap, never crossed
    specs: dict
    warranty_options: tuple               # ({"days": 30, "cost_per_day": 0.35}, ...)
    delivery_options: tuple               # ({"days": 2, "cost": 15}, ...)
    seller_toughness: float = 0.5


@dataclass
class Round:
    round: int
    seller_ask: float
    buyer_bid: float


@dataclass
class Outcome:
    listing_id: str
    seller_id: str
    agreed: bool
    price: float | None
    warranty_days: int
    delivery_days: int
    rounds: list
    buyer_utility: float | None           # warranty value - price (higher is better for buyer)
    reason: str = ""

    def public(self) -> dict:
        """Terms safe to show either side: no floors, no budgets."""
        d = asdict(self)
        d.pop("buyer_utility")
        return d


# --------------------------------------------------------------------------- guidance
def _pct(sorted_vals, p):
    if not sorted_vals:
        raise ValueError("no comparable sales")
    k = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def price_guidance(product: dict) -> dict:
    """Fair price range and negotiation anchors from recent closed deals."""
    prices = sorted(product["recent_closed_prices"])
    p25, mid, p75 = _pct(prices, 0.25), median(prices), _pct(prices, 0.75)
    return {
        "title": product["title"],
        "launch_price": product["launch_price"],
        "recent_deals": len(prices),
        "fair_range": [round(p25), round(p75)],
        "median_price": round(mid),
        "suggested_opening_offer": round(p25 - 0.5 * (mid - p25)),
        "suggested_walk_away_above": round(p75 + 0.5 * (p75 - p25)),
        "checklist": product["checklist"],
    }


# --------------------------------------------------------------------------- matching
def matches(m: Mandate, l: Listing) -> tuple[bool, str]:
    if l.product != m.product:
        return False, "different product"
    for key, minimum in m.min_specs.items():
        if l.specs.get(key, 0) < minimum:
            return False, f"{key} below requirement"
    cond = l.specs.get("condition", "C")
    if CONDITION_RANK.get(cond, 0) < CONDITION_RANK.get(m.min_condition, 0):
        return False, "condition below requirement"
    if not any(d["days"] <= m.deadline_days for d in l.delivery_options):
        return False, "cannot deliver by deadline"
    return True, ""


# --------------------------------------------------------------------------- concession
def _exponent(toughness: float) -> float:
    """Toughness 1 -> 0.3 (hold out, concede late); toughness 0 -> 2.0 (concede early)."""
    t = min(max(toughness, 0.0), 1.0)
    return 0.3 + 1.7 * (1.0 - t)


def _fraction(k: int, toughness: float) -> float:
    return (k / ROUNDS) ** (1.0 / _exponent(toughness))


def negotiate_package(m: Mandate, l: Listing, opening_offer: float,
                      warranty: dict, delivery: dict, walk_away: float | None = None) -> Outcome:
    w_days, d_days = int(warranty["days"]), int(delivery["days"])
    seller_reserve = l.floor_price + w_days * warranty["cost_per_day"] + delivery["cost"]
    # The buyer side never goes above the user's budget, and by default not above the
    # market walk-away point either (plus part of what the extra warranty is worth).
    buyer_reserve = m.max_price
    if walk_away is not None:
        buyer_reserve = min(buyer_reserve, walk_away + 0.5 * w_days * m.warranty_value_per_day)
    base = dict(listing_id=l.id, seller_id=l.seller_id, warranty_days=w_days,
                delivery_days=d_days)

    if seller_reserve > buyer_reserve:
        return Outcome(**base, agreed=False, price=None, rounds=[], buyer_utility=None,
                       reason="no overlap between the two sides' limits")

    ask0 = max(l.list_price + w_days * warranty["cost_per_day"] + delivery["cost"], seller_reserve)
    bid0 = min(opening_offer, buyer_reserve)
    rounds = []
    for k in range(ROUNDS + 1):
        ask = ask0 - (ask0 - seller_reserve) * _fraction(k, l.seller_toughness)
        bid = bid0 + (buyer_reserve - bid0) * _fraction(k, m.toughness)
        rounds.append(Round(k, round(ask, 2), round(bid, 2)))
        if bid >= ask:
            price = (ask + bid) / 2
            # whole dollars, never outside either side's limit
            if math.ceil(seller_reserve) <= math.floor(buyer_reserve):
                # whole dollars when there is room for them
                price = min(max(round(price), math.ceil(seller_reserve)), math.floor(buyer_reserve))
            else:
                # limits sit inside the same dollar: settle to the cent
                price = round(min(max(price, seller_reserve), buyer_reserve), 2)
            assert seller_reserve <= price <= buyer_reserve
            util = w_days * m.warranty_value_per_day - price
            return Outcome(**base, agreed=True, price=float(price), rounds=rounds,
                           buyer_utility=round(util, 2))
    return Outcome(**base, agreed=False, price=None, rounds=rounds, buyer_utility=None,
                   reason="no agreement within the round limit")


def negotiate_listing(m: Mandate, l: Listing, opening_offer: float,
                      walk_away: float | None = None) -> Outcome:
    """Try every warranty x delivery package; keep the one best for the buyer."""
    best = None
    for w in l.warranty_options:
        for d in l.delivery_options:
            if d["days"] > m.deadline_days:
                continue
            o = negotiate_package(m, l, opening_offer, w, d, walk_away)
            if not o.agreed:
                if best is None:
                    best = o
                continue
            if (best is None or not best.agreed
                    or (o.buyer_utility, -o.price, -o.delivery_days)
                    > (best.buyer_utility, -best.price, -best.delivery_days)):
                best = o
    return best


def run(m: Mandate, listings: list[Listing], guidance: dict) -> dict:
    """Negotiate with every matching listing in parallel and rank the results."""
    opening = guidance["suggested_opening_offer"]
    walk_away = guidance["suggested_walk_away_above"] if m.respect_market else None
    considered, skipped = [], []
    for l in sorted(listings, key=lambda x: x.id):       # fixed order = deterministic
        ok, why = matches(m, l)
        if not ok:
            if l.product == m.product:
                skipped.append({"listing_id": l.id, "reason": why})
            continue
        considered.append(negotiate_listing(m, l, opening, walk_away))
    agreed = sorted([o for o in considered if o.agreed],
                    key=lambda o: (-o.buyer_utility, o.price, o.listing_id))
    failed = [{"listing_id": o.listing_id, "reason": o.reason} for o in considered if not o.agreed]
    return {"best": agreed[:3], "no_deal": failed, "skipped": skipped,
            "sellers_contacted": len(considered)}
