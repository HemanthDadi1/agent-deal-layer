"""Signed deal records, mock escrow and the dispute panel.

POC choices (swap for production):
  * Signature = HMAC-SHA256 with a server key. Production: Ed25519 keys per party,
    hash stored in an append-only log.
  * Escrow = an in-memory state machine. Production: Stripe Connect with delayed
    payouts, so the company never holds funds itself.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os

SIGNING_KEY = os.environ.get("AGENTDEAL_SIGNING_KEY", "dev-only-key-change-me").encode()
HUMAN_REVIEW_ABOVE = 200.0      # rulings on deals above this need a human to confirm
INSPECTION_DAYS = 3


def canonical(record: dict) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def seal(record: dict) -> dict:
    body = canonical(record)
    return {
        "record": record,
        "sha256": hashlib.sha256(body).hexdigest(),
        "signature": hmac.new(SIGNING_KEY, body, hashlib.sha256).hexdigest(),
    }


def verify(sealed: dict) -> bool:
    body = canonical(sealed["record"])
    return (hashlib.sha256(body).hexdigest() == sealed["sha256"]
            and hmac.compare_digest(hmac.new(SIGNING_KEY, body, hashlib.sha256).hexdigest(),
                                    sealed["signature"]))


# ------------------------------------------------------------------ dispute panel
# Three independent reviewers; each returns a vote. Majority decides the
# recommended ruling. Deals above HUMAN_REVIEW_ABOVE, or split votes, wait for
# a human reviewer to confirm.

def _integrity_reviewer(sealed: dict, presented: dict | None) -> dict:
    if not verify(sealed):
        return {"reviewer": "integrity", "vote": "escalate", "why": "stored record failed verification"}
    if presented is not None and presented != sealed["record"]:
        return {"reviewer": "integrity", "vote": "reject_claim",
                "why": "record presented by claimant does not match the signed record"}
    return {"reviewer": "integrity", "vote": "ok", "why": "signed record verified"}


def _rule_for(claim: str, terms: dict, evidence: dict) -> dict:
    price = terms["price"]
    if claim == "arrived_dead":
        return {"outcome": "full_refund_on_return", "refund": price}
    if claim == "battery_below_promised":
        promised = terms["specs"].get("battery_health")
        measured = evidence.get("measured_battery_health")
        if promised is None or measured is None:
            return {"outcome": "need_more_evidence", "refund": 0.0}
        gap = promised - measured
        if gap <= 2:                       # within measurement tolerance
            return {"outcome": "reject_claim", "refund": 0.0}
        return {"outcome": "partial_refund", "refund": float(min(price, 5 * gap))}
    if claim == "not_as_described":
        return {"outcome": "human_judgement", "refund": 0.0}
    return {"outcome": "unknown_claim", "refund": 0.0}


def _rules_reviewer(claim, terms, evidence):
    r = _rule_for(claim, terms, evidence)
    return {"reviewer": "rules", "vote": r["outcome"], "refund": r["refund"],
            "why": "applied the fixed rule table"}


def _evidence_reviewer(claim, terms, evidence, days_since_delivery):
    if days_since_delivery > INSPECTION_DAYS:
        return {"reviewer": "evidence", "vote": "reject_claim", "why": "opened after the inspection window"}
    if not evidence:
        return {"reviewer": "evidence", "vote": "need_more_evidence", "why": "no evidence attached"}
    r = _rule_for(claim, terms, evidence)
    return {"reviewer": "evidence", "vote": r["outcome"], "refund": r["refund"],
            "why": "evidence present and inside the inspection window"}


def review_dispute(sealed: dict, claim: str, evidence: dict, days_since_delivery: int,
                   presented_record: dict | None = None) -> dict:
    terms = sealed["record"]["terms"]
    votes = [
        _integrity_reviewer(sealed, presented_record),
        _rules_reviewer(claim, terms, evidence),
        _evidence_reviewer(claim, terms, evidence, days_since_delivery),
    ]
    if votes[0]["vote"] != "ok":
        outcome = votes[0]["vote"]
        refund = 0.0
        unanimous = True
    else:
        outcome, refund = votes[1]["vote"], votes[1].get("refund", 0.0)
        unanimous = votes[1]["vote"] == votes[2]["vote"]
        if not unanimous and votes[2]["vote"] in ("reject_claim", "need_more_evidence"):
            outcome, refund = votes[2]["vote"], 0.0
    needs_human = (not unanimous or terms["price"] > HUMAN_REVIEW_ABOVE
                   or outcome in ("human_judgement", "escalate"))
    return {"votes": votes, "recommended": outcome, "refund": refund,
            "needs_human_confirmation": needs_human}
