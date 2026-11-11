# Agent Deal Layer: Project Context File

Paste this file at the start of any new AI chat to give it full context on the project. It covers everything discussed so far across three chats: (1) the Tribunal chat, (2) the A2A agent marketplace / MCP chat (POC, business plan, competitors), and (3) the vendor-agent / client-agent design chat. Last updated: 11 Nov 2026.

> Source note: the four share links you sent only load in a browser, so I could not open them directly. This file is built from your past chats, which I could read. If a share link holds something not covered here, paste it and I will merge it in.

---

## 1. Owner and one-line idea

- Owner: Sairam (26, Houston). Repo owner on GitHub: HemanthDadi1 (Tribunal demo at hemanthdadi1.github.io/tribunal).
- Working name: **Agent Deal Layer**.
- One line: a neutral marketplace layer where every vendor gets an AI sales agent and every buyer brings their own AI (ChatGPT, Claude, Gemini, Grok, DeepSeek, open source). The two agents negotiate through one shared engine, humans confirm, and escrow protects the money.
- Headline pitch: "Your AI shops like you, negotiates better than you, and proves it."
- Positioning lines: "Google tracks prices. We negotiate them." / "Your AI doesn't have to roam the internet. Send it to us once, and we keep negotiating for you until the right deal shows up."

## 2. The three threads of work

| Thread | What it is | Where it lives |
| --- | --- | --- |
| **Tribunal** | A "courthouse for AI agents": negotiating agents, signed deal records, escrow instructions, a three-judge AI dispute panel with human appeal | `tribunal.py`, `demo.py`, `test_tribunal.py` (324 tests), `web/index.html`, `web/simulation.html`; GitHub repo `tribunal` |
| **A2A marketplace / MCP POC** | A working MCP server any AI can plug into to negotiate a purchase, using one shared engine | `agent-deal-poc` / `agent-deal-layer` repo: `server.py`, `agentdeal/`, `fairness_test.py`, `demo.py`, tests (9 pass), `web/`, `pitch/` deck source |
| **Vendor and client agent product** | The full product: vendor agent (inventory, CRM, BI, pricing), client agent, decision-profile memory, autonomy levels | Claude Docs: plan, MVP scope, launch plan, selling points, pitch; docx of final documentation and pitch |

## 3. Product definition

**Vendor agent:** manages inventory, runs a CRM, gives market and BI analysis, suggests prices and marketing, negotiates for profit inside the vendor's rules (hard price floor), and asks the vendor to confirm before any deal closes.

**Client agent:** takes the buyer's requirements (product, budget, specs, delivery, warranty value), finds trusted vendors, requests and negotiates quotes, and asks the buyer to confirm. Buyer's own AI plugs in through an MCP connector.

**Deal flow:**
1. Buyer states need and limits to their AI.
2. Client agent finds trusted vendors and requests quotes.
3. Agents negotiate through the shared engine.
4. Vendor agent sends a confirmation message to the vendor; vendor confirms.
5. Vendor agent sends an acknowledgment to the client agent.
6. Client agent asks the buyer to confirm the quote.
7. Buyer pays into escrow.
8. Delivery or pickup, then escrow releases (or a dispute goes to the Tribunal).

**Revenue (current thinking):**
- Original idea: vendors pay for the agent service based on confirmed negotiations per day.
- Business-plan assumption: about 3.5% + $5 per deal (an assumption from the simulation, not validated), plus escrow/protection fee, seller subscription, and later a sold-price data API.
- Earlier ideas the review pushed back on: ads and answer-engine optimisation (AEO) for sellers. Verdict: leave out or clearly label, because paid placement conflicts with being neutral.

## 4. Core design principles (shared by Tribunal and the POC)

1. **Separate deciding from talking.** A deterministic engine holds every private limit and computes every offer. The AI on each side only collects its person's limits and explains results. So no AI can leak a limit it never saw, be argued past a hard cap, or get a worse deal because it is a weaker model.
2. **Strict structured offers.** JSON with a whitelist schema; unknown keys, wrong types and over-long strings rejected.
3. **Hard mandate guard**, independent of the strategy, checks every outgoing offer and acceptance. A strategy bug raises an error; it never produces an over-budget deal.
4. **Stop-short margin.** Each agent stops a private, random margin short of its limit, so its last offer never equals its walk-away price (a plain concession curve ends exactly at the limit and leaks it).
5. **Multi-issue bargaining.** Price traded against warranty (0/30/90 days) and delivery, so both sides can end up better off. Demo: laptop deal at ₹35,450 with a 90-day warranty created ₹7,970 of joint value vs ₹5,000 for price-only.
6. **Blind mediator.** On timeout, the mediator uses sealed limits to propose a deal at a random split inside the overlap, so it reveals neither limit.
7. **Human approval** of every deal; both parties sign the deal record (SHA-256 + Ed25519), verified against an independent identity registry, not keys stored in the record.
8. **Tribunal rulings:** three judges from three providers choose from a fixed set of outcomes; majority must agree; refund amount is the median of the majority; a split, an abstention majority, too wide a spread, or a failed integrity check freezes escrow and sends it to a human. Human sign-off above $200 in the POC.
9. **Evidence is untrusted data:** scanned for injection attempts; whoever submits one loses reputation. Evidence is escaped so it cannot close the `<case>` block.
10. **Platform never holds money.** A licensed partner (e.g. Stripe Connect) holds escrow; the platform only sends release/refund instructions.

## 5. Memory and decision profiles (Agent Deal Layer thread)

Problem: AI model memory is limited and not shared; no API reads ChatGPT or Claude memory. Answer: keep memory in a platform-owned, model-neutral **decision profile**.

- Profile parts: hard rules, stated preferences, decision history (offers accepted/rejected/countered), trade-off weights, situational patterns.
- Three routes to buyer context: (1) export prompt run in the buyer's own AI, parsed and reviewed by the buyer; (2) connector sync via an MCP remote server with OAuth 2.1 and PKCE; (3) behaviour logged on the platform.
- Learning: per-user scoring rule and similar-deal retrieval; an accept-likelihood model trained across users' deal logs; satisfaction signals (delivery rating, returns/disputes, edits at approval); a twin accuracy meter.
- Autonomy levels: **1 Suggest**, **2 Auto within rules**, **3 Twin mode** (unlocks after about 20 real decisions). Honest framing: "decides like you within your rules," not a perfect copy.
- Research cited: digital twins need behaviour data (Columbia study); Large Behavior Model paper.

## 6. Architecture

- Front doors: MCP server (ChatGPT, Claude, etc.), A2A agent card at a well-known URL (RFC 8615) registered in agent directories, API, web page for humans.
- Layers: connector layer, agent layer (vendor and client agents), shared negotiation engine, memory layer (encrypted at rest), data layer (Postgres), payments (escrow via Stripe Connect), trust layer (verified sellers, dispute panel, trust scores).
- Protocols to support or watch: MCP (Anthropic), ACP (OpenAI + Stripe), UCP (Google + Shopify), AP2 (Google, with FIDO), A2A (Google), Visa TAP.
- POC MCP tools: `get_price_guidance`, `search_offers`, `set_mandate`, `start_negotiation`, `approve_deal`, `confirm_delivery`, `open_dispute`, `publish_listing`, `get_sales_summary` (10 tools served over stdio and HTTP).
- Suggested stack: Python for the Tribunal/POC; TypeScript, Node, Fastify, Postgres, Vitest were proposed for the product build.
- **Standing requests** (the key gap found): "watch for a MacBook Air M2, battery 85%+, under $700, for 14 days." The platform keeps the request open, negotiates when a match appears, and asks the shopper to approve. Not built yet.

## 7. Results so far (all from simulations or tests, not real markets)

**POC:**
- 2,000 random negotiations: no budget or floor ever crossed; buyer-facing output never contains a floor.
- Fairness test: three differently phrased assistants got identical deals through the shared engine; without it, model skill alone moved the price by about $37.
- 30-day market simulation: small-model users overpaid about $8-10 per deal when bargaining alone vs about $2-4 for large models; with the engine, every assistant got the same price-to-market ratio.

**Tribunal simulation** (illustrative assumptions: 15% bad sellers, 600 deals/day, 30 days):

| | Today (support queue and chargebacks) | Tribunal |
| --- | --- | --- |
| Money buyers lost | ₹1.02 crore | ₹6.46 lakh |
| Median time from claim to decision | 27 days | 15 hours |
| Problems never pursued | 807 | 31 |
| Deals going to misrepresenting sellers (last 5 days) | about 20% | 0% |

Tribunal suspended all 13 misrepresenting sellers by about day 6 and no honest ones, across five random markets. The live animated page (`web/simulation.html`) shows wrong rulings and split panels too. These numbers depend on listed assumptions; treat as exploration, not evidence.

## 8. Research and facts used

- **Anthropic Project Deal** (published 24 Apr 2026): 69 employees, $100 each, 186 deals, just over $4,000. Opus sellers earned about $2.68 more per item and Opus buyers paid about $2.45 less than Haiku. People did not notice the gap. Telling an agent to bargain hard had no significant effect. 46% would pay for a similar service. Small, self-selected pilot.
- **Microsoft Magentic Marketplace:** agents were easy to manipulate and sometimes overpaid or deadlocked.
- Consumer surveys (2026): 70% comfortable using AI for deal-hunting, only 33% comfortable letting AI complete a purchase; the most common autonomous spending limit was $0; Gartner: 11% of US consumers willing to let AI decide purchases. So **human approval stays the default**.
- Visa: 71% of businesses willing to optimise offers for AI agents.
- Amazon sued Perplexity over its agent shopping on Amazon: big sites block outside agents.
- eBay completed its Depop acquisition on 30 Jul 2026; eBay Best Offer and StockX bid/ask are the structured negotiation systems agents could plug into most easily.
- Possible legal flag: a patent filing titled "Autonomous creation of agreements" (buyer agent negotiating with seller agent via sub-agents). Get a freedom-to-operate check before raising money.

## 9. Competitors and landscape

| Group | Examples | What they do | What they miss |
| --- | --- | --- | --- |
| AI assistants that remember | ChatGPT shopping, Alexa for Shopping, Google AI Mode / price tracking + Buy for me, Perplexity | Remember tastes, find and buy | Do not negotiate with sellers; not neutral across AIs |
| Consumer negotiators | CarEdge, Pine | Haggle for cars, bills, refunds | One category; do not learn the buyer |
| Seller / enterprise negotiators | Nibble (350+ orgs, about 30,000 negotiations/month), Pactum ($100M total raised, Insight Partners Series C; Walmart, Maersk) | Haggle chatbots, supplier deals | Serve one side only |
| Agent-to-agent marketplaces | DealClaw, A2A Market, Suuq, Fetch.ai Agentverse, Robutler, Causa Prima | Early agent marketplaces / rails | Small, general-purpose, little real supply; no buyer memory |
| Protocols | ACP, UCP, AP2, A2A, A2CN (proposed agent negotiation protocol; weak source, verify) | Checkout, discovery, payment mandates | One-sided shopping; no two-sided negotiation standard owned by anyone |
| Infrastructure / partners | Manif (payments and spend controls, stealth, seed, Los Angeles), Stripe, Visa, Experian Agent Trust, Kite AI Agent Passport | Money and identity layers | Build on, do not compete |
| Memory and twin builders | Mem0, Simile | Memory layer, AI copies of people | Tools, not a marketplace |
| Marketplaces | eBay (Depop, Best Offer, Live), Facebook Marketplace, OfferUp, Mercari, Poshmark, StockX, GOAT, Whatnot, B-Stock | Humans haggling or bidding | No native agent negotiation |
| OLX India | VAYA on WhatsApp; Elite Buyer for Businesses (Sep 2026) with VAYA Match, Price Intelligence, Condition Check | AI matching and condition checks | Condition Check overlaps our trust layer; closed platform |
| AEO tools | Profound ($1.8B valuation, Sep 2026) | Brand visibility in AI answers | Out of scope for us |

**The empty space:** a neutral two-sided negotiation layer, same deal on any AI model, with escrow, disputes and buyer memory, aimed at used/variable-price goods with real supply. Nobody found doing exactly this.

## 10. Selling points (USPs)

1. Buyer memory plus real negotiation (nobody combines both).
2. Platform-owned, model-neutral decision profile.
3. Fair shared engine: same inputs give the same deal on any model.
4. Bring your own AI; free for buyers.
5. Vendor agent: inventory, CRM, BI, pricing and negotiation with a hard floor.
6. Pay only for results (confirmed negotiations).
7. Human confirms, escrow protects.
8. Twin accuracy meter: autonomy is earned with proof.
9. Learns from every deal; real sold-price data (listing prices are everywhere, sold prices are rare).
10. Seller hook: "List in 30 seconds and never answer a lowball again."
11. Open front door through MCP: demand without paying to acquire it.
12. Narrow focus: one niche in one city where haggling already happens.

## 11. Limitations and risks (honest list)

1. Most buying is fixed-price, not negotiated. Negotiation fits used goods, big-ticket items, local services, B2B.
2. Giants control the rails (ACP, UCP, Stripe, Visa). If OpenAI or Google add "negotiate this price," we compete against a default. Mitigation: become the vendor network their assistants plug into.
3. Closed marketplaces may not admit third-party negotiators.
4. Cold start: need sellers with real listings and floors before buyers get value.
5. Compliance: payments (money-transmitter licensing; RBI Payment Aggregator Directions Sep 2025 in India), privacy (DPDP Act 2023), consumer law. Use a licensed escrow partner.
6. Agent manipulation and prompt injection (especially free-text buyer Q&A). Use structured offers and the engine.
7. Conflict of interest: a take rate on closed deals pays us to push early settlement. Address openly; neutrality is the pitch.
8. Unit economics at small tickets: 1-3% of a ₹3,000 deal is ₹30-90, while three AI rulings plus a human appeal cost more. Needs a cost-per-dispute model and break-even dispute rate.
9. Evidence is the bottleneck: judges cannot inspect a phone; need diagnostics, courier logs, unboxing video. Expect fake disputes and staged videos.
10. Beachhead mismatch: campus or in-person deals need the Tribunal least. Shipped goods (phones, laptops between cities) test it properly.
11. Phase 2 target (AI-human agreement above 90%) cannot be measured with 5-10 buyers; use synthetic or historical dispute sets.
12. Patent freedom-to-operate check needed.
13. Prototype gaps: seed data, simulated escrow, HMAC signatures (production needs per-party Ed25519), engine concedes to the limit unless the Tribunal stop-short and blind mediator are ported in, simulation rests on assumptions, no licence chosen.

**India legal map (not legal advice):** Consumer Protection (E-Commerce) Rules 2020 (acknowledge complaints in 48 hours, resolve in one month); Mediation Act 2023 s.30 (online mediation with written consent, so frame small claims as AI-proposed settlements both sides accept); AAA-ICDR AI arbitrator (Nov 2025) as a model: AI drafts, human signs the award; IT Act s.11(c) (an agent's deal binds its owner); RBI payment aggregator rules (escrow must be with an authorised entity; an aggregator cannot run a marketplace).

## 12. MVP, launch plan and metrics

- MVP: 12-week build, one niche (assumed used electronics; **not confirmed**).
- Targets: 20 vendors onboarded, 100 deals, +3% vendor margin, 25% close rate, disputes under 5%, zero below-floor deals.
- Roadmap: weeks 1-3 niche, escrow partner, data model, vendor onboarding; 4-6 vendor agent, CRM, engine; 7-9 client connector, deal flow, escrow; 10-12 decision profiles, pilot hardening, live deals.
- First 30 days: list 150 refurbishers/resellers; interview 30 about lowballs, pricing, and whether they'd let an agent negotiate above a floor (if most say no, change category); turn Tribunal into an engine service with a 100-deal test suite and a 3-model fairness test; build MCP tools and connect to ChatGPT developer mode and Claude; sign about 10 design-partner sellers; set up Stripe Connect in test mode; draft terms with a lawyer.
- Pilot gates: days 30-90 reach 25 sellers and 200 deals (kill criteria checked); months 4-6 public launch, ChatGPT app directory and Claude connector, pre-seed at about $15K monthly revenue; months 7-12 B2B bulk orders, second category, sold-price data API, seed at about $50K monthly revenue.
- Weekly numbers: active sellers, mandates, deals closed, approval rate, dispute rate.
- Launch budget estimate: about $9,000 to $19,000.
- **Known inconsistency:** MVP scope says 100 deals by week 12; launch plan says week 14.
- Not now: vehicles, accommodation, broad categories, a mobile app, own AI models, ad/AEO revenue.

## 13. Future scope

- Standing requests (platform keeps watching on the buyer's behalf).
- Twin mode (level 3 autonomy).
- Market simulator: a simulated e-commerce market where agents trade at scale to test pricing, tune the engine and train twins.
- Second category (used cars, IT equipment), B2B bulk orders, sold-price data API, offer an API into the sellers so Google, OpenAI or eBay agents can plug in.

## 14. Open decisions

1. Niche and city (assumed used electronics, Houston; not confirmed).
2. Escrow partner (Stripe Connect assumed).
3. Pickup-only or shipping.
4. Week 12 vs week 14 for the 100-deal goal.
5. Solo or team, time and money available; venture-style company or a smaller business.
6. Port the stop-short margin and blind mediator into the POC engine.
7. Business name, website, pilot size, fee: placeholders on the one-page pitch.
8. India or US as first market (Tribunal work uses ₹ and Indian law; Agent Deal Layer plan assumes Houston).

## 15. Artifacts and where to find them

- Claude Docs (in Claude): Agent Deal Layer plan; MVP scope; Launch Plan and GTM; Selling Points and Competitor Map; and the earlier business plan doc for the A2A/MCP chat.
- Word files made in this chat: `Agent_Deal_Layer_Final_Product_Documentation.docx`, `Agent_Deal_Layer_Pitch_Defense_USPs.docx`.
- Earlier PDFs exist for the plan, MVP scope, launch plan and competitor map. Standing preference: **no more PDFs**.
- Code: Tribunal repo (`tribunal.py`, `demo.py`, tests, `web/index.html`, `web/simulation.html`) and `agent-deal-layer` repo (`poc/`, `web/`, `pitch/`). Push to GitHub was requested "from now on, automatically"; GitHub was not connected in that session, so confirm the repos are pushed.

## 16. Working preferences

- Plain, brief answers; no PDFs; docx or Claude docs for documents.
- Wants honest ratings and "brutal" critique, not flattery.
- Does not want unrequested extra work started.
