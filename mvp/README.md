# Agent Deal Layer: MVP build

Marketplace where each vendor gets an AI sales agent and buyers bring their own AI. Both agents negotiate through **one shared engine**; both humans confirm; payment is held in escrow. Built from `Agent_Deal_Layer_MVP_Scope.pdf`.

```bash
npm install
npm test            # 44 tests, incl. 1,000-run floor/budget simulation, a real MCP client over HTTP and the Hearth routes
npm run demo        # whole deal loop in the terminal
npm start           # http://localhost:3000   (ADMIN_KEY=... PORT=... HOST=... ADL_DB=adl.db BASE_URL=https://...)
npm run hearth      # the same server plus the Hearth connector and a few seeded sellers (in-memory database)
```

Needs Node 22.13+ (uses the built-in `node:sqlite`).

The server listens on `127.0.0.1` only; set `HOST=0.0.0.0` when deploying behind HTTPS. Without `ADMIN_KEY`, each run prints its own random admin key.

## Hearth connector

[Hearth](https://github.com/HemanthDadi1/hearth) is the people-facing shell: a short chat instead of a catalog, agents that haggle, a PIN to approve. `src/hearth.ts` implements its open connector (`/hearth/*`, see Hearth's `CONNECTOR.md`) on this layer:

| Hearth | This layer |
| --- | --- |
| Seller listing (asking, private lowest, auto-confirm rule) | An approved vendor with one item; floor = lowest |
| Buyer intent (want, private most) | A mandate; budget = most. The shared engine negotiates |
| "Let my agent get it" on a product page | A mandate matched against that one item only |
| Seller taps **Confirm** | Vendor confirmation |
| Buyer taps **Approve** with a PIN | `approveQuote`: PIN check, then an escrow hold |
| Watch, wanted board, invites to outside sellers | Matching re-run for one new item against a waiting mandate |

`npm run hearth` prints the approval PIN for Hearth's buyers. Point Hearth's Connector at `http://127.0.0.1:3000`. Settings: `HEARTH_PIN`, `HEARTH_INR_PER_USD` (83), `HEARTH_ORIGINS` (`http://127.0.0.1:8090,http://localhost:8090`), `HEARTH_SEED=0` to start empty.

Known limits: every Hearth buyer shares one demo account until Hearth has login; rupees are converted to the layer's dollar range ($100 to $2,000, about ₹8,300 to ₹1,66,000); which Hearth id maps to which mandate or item is kept in memory, so `npm run hearth` uses an in-memory database too. Nothing returned to Hearth carries a floor or a budget; `test/hearth.test.ts` checks that.

## Try it in the browser
1. `ADMIN_KEY=secret npm start`, open `/admin`, sign in, create an **access code**.
2. `POST /vendors/signup` with the code (or build a form on it) to get a vendor key; approve the vendor in `/admin`; sign in at `/vendor`, import a CSV.
3. Buyer opens `/`, creates an account (PIN), posts a mandate, then approves on the hosted page.
4. Vendor confirmations arrive in the `outbox` table (and the vendor dashboard) until an email/SMS provider is wired in.

## Connect a buyer's AI
- **Remote MCP** at `POST /mcp` with `Authorization: Bearer <client key>`. Tools: `create_mandate`, `get_quotes`, `get_deal_status`, `open_dispute`. There is intentionally **no approve or pay tool**: the AI hands the human an approval link.
- **Claude Desktop (stdio)**: command `npx`, args `["tsx","src/mcp-stdio.ts"]`, env `ADL_DB`, `ADL_CLIENT_KEY`.
- **Other models**: the same actions as REST under `/v1/*` (see `src/server.ts`), plus `PUT /v1/webhook`.

## Architecture
`src/engine.ts` negotiation (stop-short margins, hard floor/budget guards, blind mediator) · `src/safety.ts` injection and pressure filter · `src/escrow.ts` escrow provider interface (simulated now, Stripe Connect stub) · `src/service.ts` all business rules · `src/server.ts` REST, MCP, hosted pages · `src/web.ts` page shell.

## MVP scope status

| Feature (priority) | Status |
| --- | --- |
| Vendor sign-up with business ID check, admin approval (Must) | Done. Format check on EIN only; no external lookup |
| CSV import with AI-filled titles/specs (Must) | Done. Fill-in is rule-based; LLM hook is `fillItem()`. Photo upload not built (URL column only) |
| Shopify import (Could) | Not built |
| Rules per item and bulk category defaults (Must) | Done |
| Stock count, auto-sold (Must) | Done |
| Vendor agent negotiates, never below floor (Must) | Done. Tested with 1,000 runs |
| Vendor confirmation by text/email/dashboard, auto-approve under a value, 2-hour expiry (Must) | Done, but email/SMS go to an `outbox` table, no provider yet |
| Simulated buyer preview (Should) | Done |
| Lead list and per-product funnel (Must) | Done |
| Price vs market median, one-tap price suggestion (Should) | Done |
| Monthly marketing plan (Could) | Not built |
| MCP connector (Must) | Built and tested over HTTP. **OAuth 2.1 + PKCE not built**: uses Bearer keys. Directory submission needs OAuth |
| REST API and webhooks (Should) | Done (webhooks send on quote ready, paid, delivered; not covered by a test) |
| Buyer web app (Must) | Done (basic) |
| Mandate, match with trust signals, best 3 quotes (Must) | Done. Matching is keyword-based |
| Hosted confirmation page, PIN-only approval (Must) | Done. 5 wrong PINs locks approvals for an hour |
| Escrow through a licensed partner (Must) | **Interface and state machine done; partner not connected.** `ESCROW=stripe` is a stub that errors |
| Pickup or shipping, delivery confirmation, auto-release after 3 days (Must) | Done |
| Disputes: client opens within 3 days, admin decides, money held (Must) | Done |
| Decision log (Must) | Done |
| Profile editor, encrypted at rest, view/export/delete (Should + privacy) | API done (AES-256-GCM); no editor UI |
| Billing counter, billing off (Should) | Done (`/vendor/billing`) |
| Admin panel (Must) | Done (vendor approval, disputes, access codes) |
| Injection and pressure filter (Must) | Done and logged. Rule-based, needs red-teaming |

## Known gaps before a real pilot
1. **Postgres**: built on SQLite for a zero-setup start; schema is plain SQL, move to Postgres before launch (the MVP scope says Postgres).
2. **OAuth 2.1 + PKCE** for the Claude and ChatGPT connector directories.
3. **Escrow partner** (Stripe Connect) and the money-transmitter check with a fintech lawyer.
4. Email/SMS provider, public HTTPS hosting, daily backups.
5. A real LLM for message wording and item fill-in (the engine decides all prices; the LLM would only phrase and parse).
6. Hashed vendor/client keys are shown once at signup; add key rotation.
7. Sessions are in memory (lost on restart); fine for a pilot of one process, not for scale.
8. Legal: terms, refund policy and escrow terms reviewed by a lawyer before the first paid deal.
