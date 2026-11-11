# Agent Deal Layer

A neutral place where a buyer's AI and a seller's AI agree on a deal. Every offer comes from **one shared engine**, so the result is the same whichever AI the buyer uses (ChatGPT, Claude, Gemini, or any MCP client). Money waits in escrow until the item checks out, and a three-reviewer panel settles disputes.

This repository is the working prototype behind the Tribunal pitch. Everything here runs on **sample data**: no real users, payments or disputes yet.


## Try it

- [Clickable negotiation demo](https://hemanthdadi1.github.io/agent-deal-layer/demo.html)
- [Live market simulation](https://hemanthdadi1.github.io/agent-deal-layer/simulation.html)

These links work once GitHub Pages is on (Settings > Pages > branch `main`, folder `/docs`). Until then, download the files and open them in a browser:
[docs/demo.html](docs/demo.html) and [docs/simulation.html](docs/simulation.html).

Rebuild with `python web/build.py`, then copy `web/dist/*.html` into `docs/`.

## What's inside

| Folder | What it is |
| --- | --- |
| [`poc/`](poc/) | Python MCP server with 10 tools, the negotiation engine, signed deal records, mock escrow, the dispute panel, an end-to-end demo, a fairness test and 9 unit tests |
| [`web/`](web/) | The same engine ported to JavaScript, plus two self-contained pages: a step-by-step demo and a live market simulation |
| [`pitch/`](pitch/) | Source for the investor deck (one HTML file per slide, built by `build_deck.py`) |

## Quick start

```bash
# MCP server, demo and tests
cd poc
pip install -r requirements.txt
python demo.py            # buyer, seller and dispute scenarios over real MCP
python fairness_test.py   # same deal for every AI vs. each AI bargaining alone
python -m pytest -q tests

# Web pages
cd ..
python web/build.py       # writes web/dist/demo.html and web/dist/simulation.html
```

Open the files in `web/dist/` in a browser; they need no server.

To connect the MCP server to Claude Desktop or ChatGPT, see [`poc/README.md`](poc/README.md).

## The core idea

**Separate deciding from talking.** The engine holds every private limit and computes every offer. The AI on each side only collects its person's limits and explains results. So no AI can leak a limit it never saw, be argued past a hard cap, or get its user a worse deal because it is a weaker model.

## Results so far (simulation)

- 2,000 random negotiations: no budget or floor ever crossed.
- Fairness test: three differently phrased assistants got identical deals; bargaining alone, model skill moved the price by $37.
- 30-day market simulation: small-model users overpaid about $8–10 per deal when bargaining alone, against about $2–4 for large models; with the engine, every assistant got the same price-to-market ratio.

## Status and known gaps

- Escrow is a state machine standing in for a licensed payment partner (for example Stripe Connect).
- Deal records use an HMAC signature; production needs per-party Ed25519 keys.
- The engine still concedes all the way to each limit by the last round. Tribunal's stop-short margin and blind mediator should be ported in.
- No licence has been chosen yet.


## MVP build (`mvp/`)

A working TypeScript implementation of the MVP scope: shared negotiation engine, vendor and buyer flows, escrow state machine, disputes, MCP connector, hosted approval page and admin panel. See [`mvp/README.md`](mvp/README.md) for setup, scope status and known gaps (escrow partner, OAuth 2.1, Postgres).
