# Agent Deal Layer: proof of concept

A working MCP server that lets **any AI assistant** (Claude, ChatGPT, or any other MCP client) negotiate a purchase for a user. Every offer is computed by **one shared engine**, so the deal does not depend on which AI model the buyer uses.

This POC proves four claims from the business plan:

| Claim | How the POC proves it | Where |
| --- | --- | --- |
| Any AI can plug in | 10 tools served over MCP (stdio and HTTP) | `server.py` |
| Same deal whichever AI is used | 3 differently phrased assistants get identical results; without the shared engine, model skill alone moves the price by $37 | `fairness_test.py` |
| Limits are never crossed or leaked | 2,000 random negotiations never cross a budget or floor; buyer-facing output never contains a floor | `tests/test_poc.py` |
| Trust layer works | Human approval required, signed and hashed deal records, escrow states, 3-reviewer dispute panel with human sign-off above $200, tampered records rejected | `agentdeal/ledger.py`, `demo.py` |

All prices and listings are **sample data** (`agentdeal/data/seed.json`), not real market prices.

## Quick start

```bash
pip install -r requirements.txt     # Python 3.10+
python demo.py                      # buyer, seller and dispute scenarios over real MCP
python fairness_test.py             # the "same deal for every AI" test
python -m pytest -q tests           # 9 tests
```

## Connect it to an AI assistant

**Claude Desktop.** Add this to `claude_desktop_config.json` (Settings > Developer > Edit Config), then restart:

```json
{
  "mcpServers": {
    "agent-deal-layer": {
      "command": "python",
      "args": ["/full/path/to/agent-deal-poc/server.py"]
    }
  }
}
```

Then ask: *"Find me a MacBook Air M2 with 16GB and battery above 85%, max $750, delivered within 4 days. A warranty is worth about $1 a day to me."*

**ChatGPT (developer mode) or any remote MCP client.** Run over HTTP and expose it with an HTTPS tunnel (for example ngrok or Cloudflare Tunnel):

```bash
python server.py --http --port 8000          # serves http://localhost:8000/mcp
ngrok http 8000                               # gives https://<id>.ngrok.app
```

Add `https://<id>.ngrok.app/mcp` as a custom connector/app in ChatGPT's developer mode. Check OpenAI's current Apps SDK docs for the exact steps.

**MCP Inspector (for debugging):** `npx @modelcontextprotocol/inspector python server.py`

## Tools

| Tool | Side | What it does |
| --- | --- | --- |
| `get_price_guidance` | Buyer | Launch price, fair range, opening offer, walk-away point, inspection checklist |
| `search_offers` | Buyer | Live inventory for a product and minimum specs |
| `set_mandate` | Buyer | Stores private limits: max price, specs, deadline, warranty value, toughness |
| `start_negotiation` | Buyer | Negotiates price + warranty + delivery with all matching sellers; returns top 3 |
| `approve_deal` | Buyer | Requires `buyer_confirmed=true`; signs the record and funds escrow |
| `confirm_delivery` | Buyer | Releases escrow, or holds it during inspection |
| `open_dispute` | Buyer | `arrived_dead`, `battery_below_promised`, `not_as_described` + evidence |
| `publish_listing` | Seller | Adds an item with a private floor price; returns pricing feedback |
| `get_sales_summary` | Seller | Deals, margin above floor after warranty and shipping costs, payouts |
| `human_review` | Operator | Confirms or overrides the panel's ruling (admin-only in production) |

## How the engine works

1. **Match:** filter listings by product, minimum specs, condition and delivery deadline.
2. **Packages:** for each listing, try every warranty and delivery option. The seller's limit for a package = floor + warranty cost + shipping cost. The buyer's limit = the budget, and by default also the market walk-away point (plus half of what the extra warranty is worth).
3. **Concession:** both sides start at their anchors (the seller's list price; the buyer's suggested opening from recent deals) and concede over 10 rounds on a curve set by each side's toughness. A deal happens when the bid meets the ask, settling at the midpoint, always inside both limits.
4. **Rank:** keep each seller's best package for the buyer (warranty value minus price) and return the top 3.

The LLM never computes a price. It only collects the user's limits and explains the results. That is what makes the outcome model-independent.

## What is mocked (and the production replacement)

| POC | Production |
| --- | --- |
| In-memory store, sample listings | Postgres; seller CSV/Shopify import |
| Comps from sample data | Licensed price data, then our own closed deals |
| HMAC-SHA256 signature | Ed25519 keys + append-only hash log |
| Escrow state machine | Stripe Connect with delayed payouts |
| One shared tool list | Separate buyer, seller and admin servers with OAuth |
| Rule-based dispute reviewers | Rules + AI evidence review + human reviewer console |

## Project layout

```
server.py              MCP server (10 tools, stdio or HTTP)
demo.py                End-to-end scenarios through a real MCP client
fairness_test.py       Same deal for every AI vs. simulated self-negotiation
agentdeal/engine.py    Matching, price guidance, multi-term concession engine
agentdeal/market.py    Marketplace state, message writer, buyer/seller operations
agentdeal/ledger.py    Signed records, escrow rules, 3-reviewer dispute panel
agentdeal/data/seed.json  Sample products, sellers, listings
tests/test_poc.py      Caps, determinism, leaks, approval, tampering, disputes
```
