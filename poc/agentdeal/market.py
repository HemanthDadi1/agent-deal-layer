"""In-memory marketplace: listings, mandates, negotiations, deals, escrow, disputes.

Every public method returns plain dicts so it can be exposed as an MCP tool.
Nothing returned to a buyer ever contains a seller's floor price, and nothing
returned to a seller ever contains a buyer's budget.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from . import engine, ledger

SEED = Path(__file__).parent / "data" / "seed.json"


def _listing_from(d: dict, toughness: float) -> engine.Listing:
    return engine.Listing(
        id=d["id"], seller_id=d["seller_id"], product=d["product"],
        list_price=float(d["list_price"]), floor_price=float(d["floor_price"]),
        specs=dict(d["specs"]), warranty_options=tuple(d["warranty_options"]),
        delivery_options=tuple(d["delivery_options"]), seller_toughness=toughness)


def write_message(outcome: engine.Outcome, listing: engine.Listing, title: str) -> str:
    """The 'message writer': explains a result in plain words.

    It is only given public terms, so it cannot leak anyone's limits.
    """
    warranty = f"{outcome.warranty_days}-day warranty" if outcome.warranty_days else "no warranty"
    saved = listing.list_price - outcome.price
    note = f", ${saved:,.0f} below the listed price" if saved > 0 else ""
    return (f"{title} from seller {outcome.seller_id}: ${outcome.price:,.0f} with {warranty}, "
            f"delivered in {outcome.delivery_days} days{note}. "
            f"Condition {listing.specs.get('condition', '?')}, battery "
            f"{listing.specs.get('battery_health', 'n/a')}%.")


class Marketplace:
    def __init__(self, seed_path: Path = SEED):
        data = json.loads(Path(seed_path).read_text())
        self.products = data["products"]
        self.sellers = data["sellers"]
        self.listings = {d["id"]: _listing_from(d, self.sellers[d["seller_id"]]["toughness"])
                         for d in data["listings"]}
        self.mandates, self.negotiations, self.deals, self.disputes = {}, {}, {}, {}
        self.audit = []
        self._n = 0

    def _id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def _log(self, event: str, **kw):
        self.audit.append({"event": event, **kw})

    # ------------------------------------------------------------- buyer side
    def get_price_guidance(self, product: str) -> dict:
        if product not in self.products:
            return {"error": f"unknown product '{product}'", "known_products": sorted(self.products)}
        return {"product": product, **engine.price_guidance(self.products[product]),
                "data_note": "POC sample data, not real market prices"}

    def search_offers(self, product: str, min_specs: dict | None = None) -> dict:
        out = []
        for l in sorted(self.listings.values(), key=lambda x: x.id):
            if l.product != product:
                continue
            if any(l.specs.get(k, 0) < v for k, v in (min_specs or {}).items()):
                continue
            out.append({"listing_id": l.id, "seller_id": l.seller_id,
                        "seller_verified": self.sellers[l.seller_id]["verified"],
                        "list_price": l.list_price, "specs": l.specs,
                        "warranty_days_available": [w["days"] for w in l.warranty_options],
                        "delivery_days_available": [d["days"] for d in l.delivery_options]})
        return {"product": product, "listings": out}

    def set_mandate(self, product: str, max_price: float, deadline_days: int = 30,
                    warranty_value_per_day: float = 0.0, min_specs: dict | None = None,
                    min_condition: str = "C", toughness: float = 0.5,
                    respect_market: bool = True, client: str = "unknown") -> dict:
        if product not in self.products:
            return {"error": f"unknown product '{product}'"}
        if max_price <= 0:
            return {"error": "max_price must be positive"}
        m = engine.Mandate(product=product, max_price=float(max_price), deadline_days=int(deadline_days),
                           warranty_value_per_day=float(warranty_value_per_day),
                           min_specs=dict(min_specs or {}), min_condition=min_condition,
                           toughness=float(toughness), respect_market=bool(respect_market))
        mid = self._id("M")
        self.mandates[mid] = m
        self._log("mandate_set", mandate_id=mid, client=client)   # budget not logged in clear
        return {"mandate_id": mid, "stored": "private: never shown to sellers"}

    def start_negotiation(self, mandate_id: str) -> dict:
        m = self.mandates.get(mandate_id)
        if m is None:
            return {"error": "unknown mandate_id"}
        guidance = engine.price_guidance(self.products[m.product])
        result = engine.run(m, list(self.listings.values()), guidance)
        nid = self._id("N")
        options = []
        for rank, o in enumerate(result["best"], 1):
            l = self.listings[o.listing_id]
            options.append({"option": rank, "offer_id": f"{nid}-{o.listing_id}",
                            "listing_id": o.listing_id, "seller_id": o.seller_id,
                            "price": o.price, "warranty_days": o.warranty_days,
                            "delivery_days": o.delivery_days, "rounds_used": len(o.rounds),
                            "summary": write_message(o, l, self.products[m.product]["title"])})
        self.negotiations[nid] = {"mandate_id": mandate_id, "outcomes": {o.listing_id: o for o in result["best"]}}
        self._log("negotiation_run", negotiation_id=nid, sellers=result["sellers_contacted"],
                  agreed=len(options))
        return {"negotiation_id": nid, "sellers_contacted": result["sellers_contacted"],
                "options": options, "no_deal": result["no_deal"], "not_matching": result["skipped"],
                "next_step": "Show the options to the user. Call approve_deal only after the user says yes."}

    def approve_deal(self, offer_id: str, buyer_confirmed: bool) -> dict:
        if not buyer_confirmed:
            return {"error": "the human buyer must confirm before money moves"}
        nid, _, lid = offer_id.partition("-")
        neg = self.negotiations.get(nid)
        if not neg or lid not in neg["outcomes"]:
            return {"error": "unknown offer_id"}
        o, l = neg["outcomes"][lid], self.listings[lid]
        did = self._id("D")
        record = {"deal_id": did, "listing_id": lid, "seller_id": o.seller_id,
                  "terms": {"product": l.product, "price": o.price, "warranty_days": o.warranty_days,
                            "delivery_days": o.delivery_days, "specs": l.specs},
                  "approved_by": ["buyer", "seller (auto-approved within their floor)"]}
        sealed = ledger.seal(record)
        self.deals[did] = {"sealed": sealed, "escrow": "FUNDED", "paid_out": 0.0, "refunded": 0.0}
        self._log("deal_signed", deal_id=did, sha256=sealed["sha256"])
        return {"deal_id": did, "escrow": "FUNDED", "amount_held": o.price,
                "record_sha256": sealed["sha256"], "record": record}

    def confirm_delivery(self, deal_id: str, accept: bool = True) -> dict:
        d = self.deals.get(deal_id)
        if not d:
            return {"error": "unknown deal_id"}
        if d["escrow"] not in ("FUNDED", "DELIVERED"):
            return {"error": f"escrow is {d['escrow']}"}
        if not accept:
            d["escrow"] = "DELIVERED"
            return {"deal_id": deal_id, "escrow": "DELIVERED",
                    "next_step": f"Open a dispute within {ledger.INSPECTION_DAYS} days if there is a problem."}
        price = d["sealed"]["record"]["terms"]["price"]
        d["escrow"], d["paid_out"] = "RELEASED", price
        self._log("escrow_released", deal_id=deal_id)
        return {"deal_id": deal_id, "escrow": "RELEASED", "paid_to_seller": price}

    def open_dispute(self, deal_id: str, claim: str, evidence: dict | None = None,
                     days_since_delivery: int = 1, presented_record: dict | None = None) -> dict:
        d = self.deals.get(deal_id)
        if not d:
            return {"error": "unknown deal_id"}
        if d["escrow"] not in ("FUNDED", "DELIVERED"):
            return {"error": f"cannot dispute, escrow is {d['escrow']}"}
        review = ledger.review_dispute(d["sealed"], claim, evidence or {}, days_since_delivery,
                                       presented_record)
        xid = self._id("X")
        self.disputes[xid] = {"deal_id": deal_id, "claim": claim, "review": review, "status": "OPEN"}
        d["escrow"] = "DISPUTED"
        if not review["needs_human_confirmation"]:
            return {"dispute_id": xid, **self._apply_ruling(xid)}
        self.disputes[xid]["status"] = "AWAITING_HUMAN"
        return {"dispute_id": xid, "status": "AWAITING_HUMAN", "review": review,
                "next_step": "A human reviewer confirms or changes the recommended ruling (human_review)."}

    def human_review(self, dispute_id: str, confirm: bool, refund_override: float | None = None) -> dict:
        x = self.disputes.get(dispute_id)
        if not x or x["status"] != "AWAITING_HUMAN":
            return {"error": "no dispute awaiting human review with that id"}
        if not confirm and refund_override is None:
            return {"error": "give refund_override when not confirming the recommendation"}
        if refund_override is not None:
            x["review"]["refund"] = float(refund_override)
            x["review"]["recommended"] = "human_override"
        return {"dispute_id": dispute_id, **self._apply_ruling(dispute_id)}

    def _apply_ruling(self, xid: str) -> dict:
        x = self.disputes[xid]
        d = self.deals[x["deal_id"]]
        price = d["sealed"]["record"]["terms"]["price"]
        refund = min(float(x["review"]["refund"]), price)
        d["refunded"], d["paid_out"] = refund, price - refund
        d["escrow"], x["status"] = "RESOLVED", "RESOLVED"
        self._log("dispute_resolved", dispute_id=xid, refund=refund)
        return {"status": "RESOLVED", "ruling": x["review"]["recommended"],
                "refund_to_buyer": refund, "paid_to_seller": price - refund,
                "votes": x["review"]["votes"]}

    # ------------------------------------------------------------- seller side
    def publish_listing(self, seller_id: str, listing_id: str, product: str, list_price: float,
                        floor_price: float, specs: dict, warranty_options: list | None = None,
                        delivery_options: list | None = None) -> dict:
        if seller_id not in self.sellers:
            return {"error": "unknown seller_id"}
        if product not in self.products:
            return {"error": f"unknown product '{product}'"}
        if floor_price > list_price:
            return {"error": "floor_price cannot be above list_price"}
        if listing_id in self.listings:
            return {"error": "listing_id already exists"}
        d = {"id": listing_id, "seller_id": seller_id, "product": product, "list_price": list_price,
             "floor_price": floor_price, "specs": specs,
             "warranty_options": warranty_options or [{"days": 0, "cost_per_day": 0}],
             "delivery_options": delivery_options or [{"days": 5, "cost": 0}]}
        self.listings[listing_id] = _listing_from(d, self.sellers[seller_id]["toughness"])
        g = engine.price_guidance(self.products[product])
        hint = ("priced above the recent fair range" if list_price > g["fair_range"][1] * 1.05
                else "priced within or below the recent fair range")
        return {"listing_id": listing_id, "status": "live", "pricing_hint": hint,
                "fair_range": g["fair_range"], "floor_price": "private: never shown to buyers"}

    def get_sales_summary(self, seller_id: str) -> dict:
        rows = []
        for did, d in self.deals.items():
            r = d["sealed"]["record"]
            if r["seller_id"] != seller_id:
                continue
            l, t = self.listings[r["listing_id"]], r["terms"]
            w_cost = next((w["cost_per_day"] for w in l.warranty_options if w["days"] == t["warranty_days"]), 0)
            d_cost = next((d["cost"] for d in l.delivery_options if d["days"] == t["delivery_days"]), 0)
            costs = t["warranty_days"] * w_cost + d_cost
            rows.append({"deal_id": did, "listing_id": r["listing_id"], "price": t["price"],
                         "warranty_and_shipping_cost": round(costs, 2),
                         "above_floor_after_costs": round(t["price"] - l.floor_price - costs, 2),
                         "warranty_days": r["terms"]["warranty_days"], "escrow": d["escrow"],
                         "paid_out": d["paid_out"]})
        return {"seller_id": seller_id, "deals": rows,
                "total_paid_out": round(sum(x["paid_out"] for x in rows), 2)}
