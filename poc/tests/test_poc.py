import itertools
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentdeal import engine, ledger  # noqa: E402
from agentdeal.market import Marketplace  # noqa: E402

LAPTOP = "macbook-air-m2-16gb"


def test_hard_caps_never_crossed():
    """Across 2,000 random limit combinations, no deal crosses a budget or a floor."""
    rng = random.Random(7)
    mk = Marketplace()
    g = engine.price_guidance(mk.products[LAPTOP])
    listings = [l for l in mk.listings.values() if l.product == LAPTOP]
    for _ in range(2000):
        m = engine.Mandate(product=LAPTOP, max_price=rng.uniform(550, 900),
                           deadline_days=rng.randint(1, 10),
                           warranty_value_per_day=rng.uniform(0, 2),
                           toughness=rng.random(), respect_market=rng.random() < 0.5)
        for o in engine.run(m, listings, g)["best"]:
            l = mk.listings[o.listing_id]
            w = next(x for x in l.warranty_options if x["days"] == o.warranty_days)
            d = next(x for x in l.delivery_options if x["days"] == o.delivery_days)
            assert o.price <= m.max_price
            assert o.price >= l.floor_price + o.warranty_days * w["cost_per_day"] + d["cost"]
            assert o.delivery_days <= m.deadline_days


def test_deterministic():
    mk = Marketplace()
    g = engine.price_guidance(mk.products[LAPTOP])
    m = engine.Mandate(product=LAPTOP, max_price=740, warranty_value_per_day=0.5)
    a = engine.run(m, list(mk.listings.values()), g)
    b = engine.run(m, list(reversed(list(mk.listings.values()))), g)
    assert [o.public() for o in a["best"]] == [o.public() for o in b["best"]]


def test_no_overlap_means_no_deal():
    mk = Marketplace()
    g = engine.price_guidance(mk.products[LAPTOP])
    m = engine.Mandate(product=LAPTOP, max_price=500)
    r = engine.run(m, list(mk.listings.values()), g)
    assert r["best"] == []
    assert r["no_deal"]


def test_buyer_outputs_never_leak_floor_prices():
    mk = Marketplace()
    floors = {f"{l.floor_price:.0f}" for l in mk.listings.values()}
    m = mk.set_mandate(LAPTOP, 750, deadline_days=4, warranty_value_per_day=1.0)
    out = json.dumps([mk.search_offers(LAPTOP), mk.start_negotiation(m["mandate_id"])])
    assert "floor" not in out
    for o in mk.start_negotiation(m["mandate_id"])["options"]:
        # summaries are written from public terms only
        assert not any(f"${f}" in o["summary"] for f in floors if f != f"{o['price']:.0f}")


def test_approval_requires_human_confirmation():
    mk = Marketplace()
    m = mk.set_mandate(LAPTOP, 750, deadline_days=4)
    offer = mk.start_negotiation(m["mandate_id"])["options"][0]["offer_id"]
    assert "error" in mk.approve_deal(offer, buyer_confirmed=False)
    assert mk.approve_deal(offer, buyer_confirmed=True)["escrow"] == "FUNDED"


def test_signed_record_detects_tampering():
    sealed = ledger.seal({"deal_id": "D1", "terms": {"price": 685.0, "specs": {"battery_health": 90}}})
    assert ledger.verify(sealed)
    forged = json.loads(json.dumps(sealed))
    forged["record"]["terms"]["price"] = 585.0
    assert not ledger.verify(forged)


def test_dispute_with_altered_record_is_rejected():
    mk = Marketplace()
    m = mk.set_mandate(LAPTOP, 700, deadline_days=5, min_specs={"battery_health": 90})
    offer = mk.start_negotiation(m["mandate_id"])["options"][0]["offer_id"]
    deal = mk.approve_deal(offer, True)
    altered = json.loads(json.dumps(deal["record"]))
    altered["terms"]["specs"]["battery_health"] = 99
    x = mk.open_dispute(deal["deal_id"], "battery_below_promised",
                        {"measured_battery_health": 90}, 1, presented_record=altered)
    assert x["review"]["recommended"] == "reject_claim"


def test_dispute_outside_window_is_rejected_and_small_deals_auto_resolve(monkeypatch):
    monkeypatch.setattr(ledger, "HUMAN_REVIEW_ABOVE", 500.0)   # treat a ~$225 monitor as small
    mk = Marketplace()
    m = mk.set_mandate("monitor-27-4k", 260, deadline_days=7)
    offer = mk.start_negotiation(m["mandate_id"])["options"][0]["offer_id"]
    deal = mk.approve_deal(offer, True)
    late = mk.open_dispute(deal["deal_id"], "arrived_dead", {"photo": "x"}, days_since_delivery=10)
    # split vote (rules says refund, evidence says too late) -> needs a human
    assert late["status"] == "AWAITING_HUMAN"
    assert late["review"]["recommended"] == "reject_claim" and late["review"]["refund"] == 0.0

    mk2 = Marketplace()
    m2 = mk2.set_mandate("monitor-27-4k", 260, deadline_days=7)
    offer2 = mk2.start_negotiation(m2["mandate_id"])["options"][0]["offer_id"]
    deal2 = mk2.approve_deal(offer2, True)
    ok = mk2.open_dispute(deal2["deal_id"], "arrived_dead", {"photo": "x"}, days_since_delivery=1)
    assert ok["status"] == "RESOLVED" and ok["refund_to_buyer"] == deal2["amount_held"]


def test_warranty_creates_value_for_both_sides():
    """A buyer who values warranty picks a warranty package, and the seller still clears costs."""
    mk = Marketplace()
    g = engine.price_guidance(mk.products[LAPTOP])
    l1 = mk.listings["L1"]
    no_w = engine.Mandate(product=LAPTOP, max_price=750, deadline_days=5)
    likes_w = engine.Mandate(product=LAPTOP, max_price=750, deadline_days=5, warranty_value_per_day=1.0)
    assert engine.negotiate_listing(no_w, l1, g["suggested_opening_offer"]).warranty_days == 0
    assert engine.negotiate_listing(likes_w, l1, g["suggested_opening_offer"]).warranty_days > 0
