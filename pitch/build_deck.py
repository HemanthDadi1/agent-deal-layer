import json, os

import pathlib
ROOT = str(pathlib.Path(__file__).parent / "deck")
os.makedirs(ROOT + "/slides", exist_ok=True)

SANS = "'IBM Plex Sans', Arial, sans-serif"
MONO = "'IBM Plex Mono', 'Courier New', monospace"
INK, PAPER, CARD, LINE = "#121826", "#F4F5F1", "#FBFBF9", "#DCE0E6"
MUTED, BLUE, AMBER = "#4A5568", "#2453C7", "#A85A0C"
SOFTBLUE = "#E3E9F8"

LIGHT = f"background:{PAPER};color:{INK};font-family:{SANS};padding:128px 128px 160px;display:flex;flex-direction:column;gap:44px"


def head(eyebrow, title, size=64):
    return (f'<div style="display:flex;flex-direction:column;gap:16px">'
            f'<p style="font-family:{MONO};font-size:24px;color:{BLUE};letter-spacing:2px;text-transform:uppercase">{eyebrow}</p>'
            f'<h2 style="font-size:{size}px;font-weight:600;line-height:1.1;color:{INK}">{title}</h2></div>')


def foot(n, note=""):
    s = ""
    if note:
        s += f'<p style="position:absolute;left:128px;bottom:64px;width:1380px;font-size:24px;color:#6B7280">{note}</p>'
    s += f'<p style="position:absolute;left:1592px;bottom:64px;width:200px;font-family:{MONO};font-size:24px;color:#6B7280;text-align:right">Tribunal · {n:02d}</p>'
    return s


def card(inner, extra="", pad=36):
    return f'<div style="background:{CARD};border:1px solid {LINE};border-radius:16px;padding:{pad}px;display:flex;flex-direction:column;gap:12px{extra}">{inner}</div>'


def h3(t, size=34, color=INK):
    return f'<h3 style="font-size:{size}px;font-weight:600;line-height:1.2;color:{color}">{t}</h3>'


def p(t, size=28, color=MUTED, extra=""):
    return f'<p style="font-size:{size}px;line-height:1.4;color:{color}{extra}">{t}</p>'


def section(id_, style, body, notes, transition="fade"):
    return f'<section id="{id_}" data-transition="{transition}" style="{style}">\n{body}\n<aside>{notes}</aside>\n</section>\n'


slides = {}

# 1 cover --------------------------------------------------------------------
slides["cover"] = section("cover",
    f"background:{INK};color:{PAPER};font-family:{SANS};padding:128px;display:flex;flex-direction:column;justify-content:space-between",
    f'<p style="font-family:{MONO};font-size:24px;color:#8FB0FF;letter-spacing:2px;text-transform:uppercase">Investor pitch · [Month 2026]</p>'
    f'<div style="display:flex;flex-direction:column;gap:32px">'
    f'<h1 style="font-size:144px;font-weight:600;line-height:1.05;color:{PAPER}">Tribunal</h1>'
    f'<p style="font-size:48px;line-height:1.25;color:{PAPER};width:1400px">The trust layer for deals that AI agents make for people.</p>'
    f'<p style="font-size:32px;line-height:1.4;color:#B8C2D6;width:1400px">Any AI can negotiate. We keep each person’s limits sealed, hold the money, and settle disputes with a neutral panel.</p></div>'
    f'<p style="font-size:26px;color:#B8C2D6">[Founder names] · [contact email]</p>',
    "Open with the one-liner: Tribunal is the trust layer for deals AI agents make for people. Everything else in the deck supports that sentence.",
    transition="fade")

# 2 problem -----------------------------------------------------------------
cards = [
    ("It leaks its owner’s limit", "A step-by-step agent ends right next to its limit. In our stress test, a naive agent offered within ₹100 of the seller’s real floor in 652 of 652 long negotiations."),
    ("It can be talked into a bad deal", "Microsoft’s Magentic Marketplace study found agents easy to manipulate and quick to accept the first acceptable offer."),
    ("A weaker AI quietly costs more", "In Anthropic’s Project Deal, people whose agent ran on a weaker model got worse prices, and most did not notice."),
    ("Nobody settles the dispute", "When a used laptop arrives dead, there is no shared record of the deal, no money held back and no neutral referee."),
]
grid = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">' + "".join(card(h3(t, 32) + p(b, 26), pad=28) for t, b in cards) + "</div>"
slides["problem"] = section("problem", LIGHT,
    head("The problem", "Agents can already negotiate and pay. Nobody can trust the deals they make.") + grid +
    foot(2, "Sources: Tribunal stress test; Microsoft Research, Magentic Marketplace (2025); Anthropic, Project Deal (Apr 2026)."),
    "Four things break when an agent buys or sells for a person. The first is our own measurement; the other three come from Microsoft and Anthropic research.")

# 3 trust gap ----------------------------------------------------------------
def big(num, label, color=INK):
    return (f'<div style="flex:1;display:flex;flex-direction:column;gap:16px;border-top:4px solid {color};padding:32px 0 0 0">'
            f'<p style="font-size:96px;font-weight:600;line-height:1.05;color:{color}">{num}</p>'
            f'<p style="font-size:30px;line-height:1.4;color:{MUTED}">{label}</p></div>')
row = ('<div style="display:flex;gap:56px">' +
       big("77.6%", "of US shoppers used AI for a buying decision in the last six months") +
       big("$0", "was the most common limit they would set for fully autonomous purchases", AMBER) +
       big("70% → 33%", "comfortable letting AI hunt for deals, versus letting it complete the purchase") + "</div>")
slides["trustgap"] = section("trustgap", LIGHT,
    head("Why now", "People already shop with AI. They won’t let it spend.") + row +
    f'<p style="font-size:40px;font-weight:600;line-height:1.25;color:{BLUE}">The missing piece is trust: limits kept, money held, disputes settled.</p>' +
    foot(3, "Sources: Exploding Topics survey of 1,009 US consumers (Apr 2026), via TechWyse; survey of 1,000 AI-active US consumers (Mar 2026), via Chain Store Age."),
    "Adoption is not the problem; trust is. Most people use AI to shop but will not let it spend on its own. That gap is exactly what Tribunal closes.")

# 4 rails stop at checkout ---------------------------------------------------
rows = [
    ("OpenAI + Stripe ACP", "Checkout inside ChatGPT", "Bargaining, escrow, disputes"),
    ("Google UCP + AP2", "Shopping journey, signed payment mandates", "Negotiation between two agents"),
    ("Visa, Mastercard agent tokens", "Scoped cards for agents", "Anything after the payment"),
    ("Google price tracking + “Buy for me”", "Buys when a price drops", "Negotiation, used goods"),
    ("MCP and A2A", "Any AI can find and call a service", "Nothing: this is our front door"),
]
tbl = (f'<table style="font-size:26px;color:{INK};font-family:{SANS}">'
       f'<tr><th style="width:34%;text-align:left">Rail</th><th style="width:33%;text-align:left">What it does</th><th style="width:33%;text-align:left">What it leaves out</th></tr>' +
       "".join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>' for a, b, c in rows) + "</table>")
slides["whynow"] = section("whynow", LIGHT,
    head("Why now", "Payment rails for agents exist. They stop at checkout.") + tbl +
    p("None of them covers negotiation between two agents, held money for strangers, or a referee. That is the layer we build, on top of these rails.", 28, MUTED) +
    foot(4, "Sources: Eco, agent payment protocols compared (Apr 2026); Google Shopping and Google Pay help pages."),
    "The plumbing arrived in 2025 and 2026. Every rail ends at a fixed-price checkout. MCP and A2A matter because they let any AI reach us without custom integration.")

# 5 solution -----------------------------------------------------------------
steps = [
    ("1  Negotiate", "Limits stay private. Price, warranty and delivery traded together."),
    ("2  Approve, sign", "Both people approve. One signed, hashed record."),
    ("3  Escrow", "A licensed partner holds the money until inspection."),
    ("4  Tribunal", "Three judges rule on evidence. Unclear cases go to a human."),
]
flow = '<div style="display:flex;gap:24px;align-items:stretch">'
for i, (t, b) in enumerate(steps):
    flow += card(h3(t, 32, BLUE) + p(b, 26), ";flex:1", pad=32)
flow += "</div>"
band = (f'<div style="background:{SOFTBLUE};border-radius:16px;padding:28px 36px;display:flex;flex-direction:column;gap:8px">'
        f'<p style="font-size:30px;font-weight:600;color:{INK}">Any AI comes in: ChatGPT, Claude, Gemini or a company’s own agent</p>'
        f'<p style="font-size:26px;color:{MUTED}">Through an MCP server, an A2A agent card, an API, or a “negotiate with my agent” link on a listing that already exists.</p></div>')
slides["solution"] = section("solution", LIGHT,
    head("The product", "Tribunal takes a deal from first offer to final payout.") + band + flow +
    p("No AI alone can bind a person or release their money.", 30, INK) + foot(5),
    "Four steps, and a front door any AI can use. The person always approves before anything is binding, and the money never moves on an AI’s say-so.")

# 6 core insight (accent statement) -----------------------------------------
def col(t, items):
    return (f'<div style="flex:1;display:flex;flex-direction:column;gap:16px;border-top:2px solid #9DB5F0;padding:28px 0 0 0">'
            f'<h3 style="font-size:40px;font-weight:600;color:{PAPER}">{t}</h3>' +
            "".join(f'<p style="font-size:28px;line-height:1.4;color:#DCE5FA">{x}</p>' for x in items) + "</div>")
res = ('<div style="display:flex;gap:40px">' + "".join(
    f'<div style="flex:1;display:flex;gap:16px;align-items:flex-start"><x-icon name="Check" style="color:{PAPER};width:40px;height:40px"></x-icon>'
    f'<p style="font-size:28px;line-height:1.35;color:{PAPER}">{t}</p></div>' for t in [
        "No limit can leak from a model that never saw it",
        "The same deal whichever AI the buyer brings",
        "No prompt can argue the engine past a cap"]) + "</div>")
slides["insight"] = section("insight",
    f"background:{BLUE};color:{PAPER};font-family:{SANS};padding:128px;display:flex;flex-direction:column;gap:48px",
    f'<p style="font-family:{MONO};font-size:24px;color:#DCE5FA;letter-spacing:2px;text-transform:uppercase">The core idea</p>'
    f'<h2 style="font-size:96px;font-weight:600;line-height:1.05;color:{PAPER}">Separate deciding from talking.</h2>'
    '<div style="display:flex;gap:56px">' +
    col("Our engine decides", ["Holds every private limit", "Computes every offer and counter-offer", "Checks hard caps before anything goes out"]) +
    col("Any AI talks", ["Collects the person’s limits and preferences", "Explains offers in plain words", "Never sees the other side’s limits"]) +
    "</div>" + res,
    "This is the idea everything rests on. Because the language model never holds the numbers, it can neither leak them nor be argued out of them. It also means the buyer’s choice of AI stops mattering.",
    transition="push")

# 7 scenarios ------------------------------------------------------------------
def scen(tag, title, items, color):
    lis = "".join(f"<li>{x}</li>" for x in items)
    return card(f'<p style="font-family:{MONO};font-size:24px;color:{color};letter-spacing:2px;text-transform:uppercase">{tag}</p>' + h3(title, 34) +
                f'<ol style="font-size:26px;line-height:1.4;color:{MUTED}">{lis}</ol>', ";flex:1")
slides["scenarios"] = section("scenarios", LIGHT,
    head("How it feels", "Each side states its limits once. Tribunal does the rest.") +
    '<div style="display:flex;gap:32px;align-items:stretch">' +
    scen("Buyer", "Leaves a standing request", [
        "Tells their AI: battery 85% or better, under my limit, within 14 days",
        "Tribunal keeps watching and negotiates when a match appears",
        "Taps approve; the money goes into escrow"], BLUE) +
    scen("Seller", "Lists once, stops chasing lowballers", [
        "Sets a private floor and what a warranty costs them",
        "Adds a “negotiate with my agent” link to listings they already have",
        "Any buyer’s AI negotiates; the floor is never crossed or shown"], AMBER) +
    scen("Dispute", "Evidence decides, not volume", [
        "Battery promised at 80%, measured at 71%",
        "The signed record proves what was agreed",
        "Three judges; the refund is the median of the majority; a split goes to a human"], INK) +
    "</div>" + foot(7),
    "Walk through one person on each side. The standing request is what makes ‘my agent is out there finding deals’ true today, even though consumer AIs only run during a chat.")

# 8 proof ----------------------------------------------------------------------
def tile(n, label, color=INK):
    return card(f'<p style="font-size:60px;font-weight:600;line-height:1.1;color:{color}">{n}</p>' + p(label, 26), ";flex:1")
tiles = ('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px">' +
         tile("0", "limit breaches in 2,000 simulated negotiations", BLUE) +
         tile("99.9%", "of possible deals closed (1,609 of 1,611)") +
         tile("100% → 0%", "negotiations ending next to the seller’s floor, before and after the stop-short margin") +
         tile("+8%", "joint value when warranty is traded together with price") +
         tile("Identical", "deals for three differently phrased assistants, against a $37 spread when each bargained alone", BLUE) +
         tile("343", "automated tests passing across both proofs of concept") + "</div>")
slides["proof"] = section("proof", LIGHT,
    head("Proof so far", "Two working proofs of concept. The rules hold.") + tiles +
    foot(8, "Simulation only: no real users, payments or disputes yet. Sources: Tribunal repository and Agent Deal Layer MCP server."),
    "Be upfront that this is technical proof, not market proof. The numbers show the engine keeps limits, closes deals and treats every AI the same.")

# 9 fairness chart --------------------------------------------------------------
data = [("Large models", "3 assistants", 3.3, "#8C96A8"), ("Mid-size models", "2 assistants", 7.0, AMBER), ("Small model", "1 assistant", 9.5, AMBER)]
mx = 10.0
bars = ""
for name, sub, v, c in data:
    w = int(1000 * v / mx)
    bars += (f'<div style="display:flex;align-items:center;gap:32px">'
             f'<div style="width:360px;display:flex;flex-direction:column;gap:4px"><p style="font-size:32px;font-weight:600;color:{INK}">{name}</p><p style="font-size:24px;color:{MUTED}">{sub}</p></div>'
             f'<div style="width:{w}px;height:64px;background:{c};border-radius:8px"></div>'
             f'<p style="font-family:{MONO};font-size:36px;font-weight:500;color:{INK}">+${v:.1f}</p></div>')
bars += (f'<div style="display:flex;align-items:center;gap:32px;border-top:2px solid {LINE};padding:28px 0 0 0">'
         f'<div style="width:360px"><p style="font-size:32px;font-weight:600;color:{BLUE}">With our engine</p></div>'
         f'<p style="font-size:32px;color:{BLUE}">$0 difference: every assistant gets the same deal for the same request</p></div>')
slides["fairness"] = section("fairness", LIGHT,
    head("Fairness", "Without a shared engine, users of weaker AIs pay more.") +
    p("Average extra paid per deal when the buyer’s own AI bargains alone, against the same seller and listing", 30, MUTED) +
    f'<div style="display:flex;flex-direction:column;gap:28px">{bars}</div>' +
    foot(9, "Market simulation, 30 days, about 750 deals, seed 7, sample US-dollar prices. Assistant skill levels are assumptions."),
    "Each closed deal in the simulation was replayed with the buyer’s AI negotiating on its own. Weaker models open higher and concede faster, so their users overpay. With the engine, the assistant has no effect on the price.")

# 10 demos ------------------------------------------------------------------------
def demo(t, b, link, label):
    return card(h3(t, 34) + p(b, 26) + f'<p style="font-size:26px;font-family:{MONO}"><a href="{link}">{label}</a></p>', ";flex:1")
slides["demos"] = section("demos", LIGHT,
    head("See it working", "Four things you can open today.") +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">' +
    demo("Live market simulation", "Buyer agents from six assistants, live negotiations, escrow and disputes over 30 simulated days.", "https://claude.ai/artifact/S54STmdk3ro4nSb2mi8nba", "Open the simulation") +
    demo("Step-by-step demo", "One buyer, one seller, one dispute and the fairness test, each on its own tab.", "https://claude.ai/artifact/4CacUQa1Jo3LKEtNzaaZ9V", "Open the demo") +
    demo("Tribunal four-act demo", "Private mandates, signed record, escrow and the three-judge panel in the browser.", "https://hemanthdadi1.github.io/tribunal/", "hemanthdadi1.github.io/tribunal") +
    demo("Code", "Tribunal engine and HTTP API (334 tests); MCP server any AI can connect to (10 tools).", "https://github.com/HemanthDadi1/tribunal", "github.com/HemanthDadi1/tribunal") +
    "</div>" + foot(10, "Demo pages are private until shared from their page."),
    "If time allows, show the market simulation live at 12x speed. Make sure each link is shared before the meeting.")

# 11 market -----------------------------------------------------------------------
seg = "".join(f'<li>{x}</li>' for x in [
    "<b>Used electronics</b>: high value, checkable evidence (diagnostics, serials, photos)",
    "<b>Vehicles and two-wheelers</b>: high value, title transfer risk",
    "<b>Freelance and services</b>: milestone escrow already accepted",
    "<b>B2B surplus and refurbished stock</b>: larger tickets, repeat parties"])
cand = lambda t, items: card(h3(t, 30) + "".join(p("• " + x, 26) for x in items), "", pad=28)
slides["market"] = section("market", LIGHT,
    head("Market", "Trust breaks first in used, high-value goods.") +
    '<div style="display:flex;gap:40px">'
    f'<div style="width:620px;display:flex;flex-direction:column;gap:16px">{h3("Where trust breaks first", 32)}<ol style="font-size:26px;line-height:1.4;color:{MUTED}">{seg}</ol></div>'
    '<div style="flex:1;display:flex;flex-direction:column;gap:20px">' + h3("A pilot picks where we start", 32) +
    cand("Candidate A: peer-to-peer resale, India", ["OLX India alone: 180 million+ annual users", "Trust is the main reason deals between strangers fail", "Escrow through an RBI-authorised partner"]) +
    cand("Candidate B: used and refurbished electronics, US", ["Big platforms block outside agents; sellers need a neutral venue", "Google tracks prices; nobody negotiates them"]) +
    "</div></div>" +
    p("<b>Decision gate:</b> share paid online · dispute rate · a partner ready · deal size", 28, INK) +
    foot(11, "Source: HDFC Sky on OLX India (Jul 2025). Market size is sized bottom-up with the pilot partner’s data."),
    "We deliberately have not fixed the first market. Both candidates share the same problem; the pilot data decides. Sizing is bottom-up from deals that need trust, not total resale value.")

# 12 competition ----------------------------------------------------------------------
comp = [
    ("Google “Buy for me”", "No", "No", "No", "No", "Rarely"),
    ("Payment rails (ACP, AP2)", "No", "Partly", "No", "No", "No"),
    ("Pactum, Nibble", "One side", "No", "No", "No", "No"),
    ("Fetch.ai, DealClaw", "DIY", "Partly", "Early", "No", "No"),
    ("Classifieds", "Chat only", "No", "Rarely", "Desk", "Yes"),
    ("Escrow providers", "No", "No", "Yes", "No", "Partly"),
]
ct = (f'<table style="font-size:28px;color:{INK};font-family:{SANS}">'
      '<tr><th style="width:30%;text-align:left">Player</th><th style="width:14%;text-align:left">Negotiates</th><th style="width:14%;text-align:left">Any AI</th><th style="width:14%;text-align:left">Holds money</th><th style="width:14%;text-align:left">Disputes</th><th style="width:14%;text-align:left">Used goods</th></tr>' +
      "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in comp) +
      f'<tr style="background:{SOFTBLUE}"><td><b>Tribunal</b></td><td><b>Yes, neutral</b></td><td><b>Yes</b></td><td><b>Via partner</b></td><td><b>Yes</b></td><td><b>Yes</b></td></tr></table>')
slides["competition"] = section("competition", LIGHT,
    head("Competition", "Others solve one piece. Nobody connects them.") + ct +
    foot(12, "Qualitative, from each product’s published scope; none has been benchmarked against Tribunal."),
    "Google is the closest threat: it already watches prices and buys. It does not negotiate, does not handle used goods well, and only works inside Google. Pactum and Nibble prove companies pay for automated negotiation, but each serves one side.")

# 13 moat ---------------------------------------------------------------------------
diff = "".join(f'<li>{x}</li>' for x in [
    "<b>Neutral, open rules</b>: no paid influence inside a negotiation",
    "<b>Same deal for every AI</b>: proven by the fairness test",
    "<b>Verified items</b>: battery, serial and lock checks at listing",
    "<b>Standing requests</b>: we keep negotiating while the person is away",
    "<b>Links on existing listings</b>: reach sellers without asking any platform"])
keep = card(h3("What a fast follower can’t copy", 32) + "".join(p("• " + x, 27) for x in [
    "History of signed deals and rulings, for calibrating judges",
    "A verified seller network in our first category",
    "Real sold prices, which big platforms keep closed",
    "Integrations with escrow and payment partners"]) +
    p("The engine and MCP server can be rebuilt in weeks. We open-source them on purpose, to earn trust.", 26, BLUE), ";width:720px")
slides["moat"] = section("moat", LIGHT,
    head("Why we win", "Stand out on trust in used goods, not on AI.") +
    f'<div style="display:flex;gap:48px"><div style="flex:1;display:flex;flex-direction:column;gap:16px">{h3("How we’re different", 32)}<ol style="font-size:27px;line-height:1.45;color:{MUTED}">{diff}</ol></div>{keep}</div>' +
    foot(13),
    "Be honest that the code is not the moat. The moat is what accumulates: trust history, verified sellers, price data and partner integrations.")

# 14 business model --------------------------------------------------------------------
bm = [
    ("Escrow and deal fee", "Platform (may pass to buyer)", "Share of each settled deal", "[__%, with a floor]"),
    ("Dispute fee", "Platform or the losing party", "Flat fee per case heard", "[__ per case]"),
    ("Human arbitration", "Platform", "Per escalated case", "[__ per case]"),
    ("Platform licence", "Platform or agent builder", "Monthly, by deal volume", "[__ per month]"),
    ("Seller tools", "Sellers", "Monthly subscription", "[__ per month]"),
    ("Sold-price data", "Lenders, insurers, apps", "Usage-based, later", "[later]"),
]
bt = (f'<table style="font-size:26px;color:{INK};font-family:{SANS}">'
      '<tr><th style="width:24%;text-align:left">Revenue line</th><th style="width:28%;text-align:left">Who pays</th><th style="width:28%;text-align:left">Charged as</th><th style="width:20%;text-align:left">Price</th></tr>' +
      "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in bm) + "</table>")
slides["model"] = section("model", LIGHT,
    head("Business model", "Platforms pay per deal.") + bt +
    card(p("<b>People’s own AIs pay for the talking.</b> Negotiation runs as plain code; we pay only the payment partner, AI judges on disputed deals and humans on escalated ones.", 26, INK), pad=28) +
    foot(14, "Prices in brackets are set with pilot partners once their baseline costs are known."),
    "Profit per deal is the fee minus the payment partner’s cost, minus judge cost times the dispute rate, minus human cost times the escalation rate. Settling clear cases automatically keeps the expensive human part small.")

# 15 go to market ---------------------------------------------------------------------
ch = [
    ("Platforms", "Founder-led sales to heads of trust and safety and of payments", "They own the fraud cost and the budget"),
    ("Escrow and payment partners", "We become their dispute layer", "They have the licence; we add judgement"),
    ("Agent builders", "MCP server, A2A agent card and SDK", "Rides the growth of ChatGPT, Claude and AP2 agents"),
    ("Sellers", "“Negotiate with my agent” links on listings they already have", "Brings supply without any platform’s permission"),
    ("Developers", "Open-source the engine; host judges and records as a service", "Earns trust in our neutrality"),
]
gt = (f'<table style="font-size:24px;color:{INK};font-family:{SANS}">'
      '<tr><th style="width:22%;text-align:left">Channel</th><th style="width:42%;text-align:left">How</th><th style="width:36%;text-align:left">Why it works</th></tr>' +
      "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in ch) + "</table>")
slides["gtm"] = section("gtm", LIGHT,
    head("Go to market", "Disputes first, negotiation second.") +
    p("Platforms already pay for disputes; agent negotiation is still arriving. We earn trust on deals people make today, then switch on agents.", 30, INK) + gt +
    foot(15),
    "The entry offer is escrow plus the Tribunal on a platform’s existing fixed-price listings. Agent negotiation is switched on once trust in disputes is earned, which lowers the platform’s perceived risk.")

# 16 roadmap ------------------------------------------------------------------------
phase = lambda t, w, items, hi=False: card(
    f'<p style="font-family:{MONO};font-size:24px;color:{BLUE if hi else MUTED}">{w}</p>' + h3(t, 30) + "".join(p(x, 26) for x in items),
    f";flex:1{';border:2px solid ' + BLUE if hi else ''}")
slides["roadmap"] = section("roadmap", LIGHT,
    head("Next 90 days", "Prove it with one partner before we scale.") +
    '<div style="display:flex;gap:24px;align-items:stretch">' +
    phase("Choose the market", "Before day 1", ["15–20 platform interviews", "Check partners touch the payment", "Rerun the leak test with an AI writing messages"], True) +
    phase("Escrow and disputes", "Weeks 1–4", ["Integrate on one category", "Measure baseline dispute and fraud rates"]) +
    phase("Judges under review", "Weeks 5–8", ["Every dispute through Tribunal", "A human checks every ruling"]) +
    phase("Agents switched on", "Weeks 9–12", ["Agent negotiation for a test group", "Compare with a control group"]) +
    "</div>" +
    p("<b>Pass if:</b> judges agree with the human arbitrator in most cases · disputes resolve faster than the partner’s desk · the agent group closes more deals.", 28, INK) +
    foot(16, "Exact targets are set with the partner from its baseline."),
    "Market proof, not more technical proof, is what we need next. The first column is what decides the market question we deliberately left open.")

# 17 risks ----------------------------------------------------------------------------
rk = [
    ("Platforms won’t hand over disputes", "Start as recommendations the platform approves; prove speed and cost"),
    ("No licensed escrow partner", "Rulings become recommendations; the platform refunds"),
    ("People don’t trust AI judges", "AI summarises evidence; a human signs every ruling"),
    ("Agent commerce grows slowly", "Sell escrow and disputes for deals people make by hand"),
    ("Google or card networks add negotiation", "Be the neutral layer they plug into; license the engine"),
    ("Fake evidence, prompt injection", "Fixed outcomes; evidence treated as data; injection counts against the sender"),
]
rt = (f'<table style="font-size:27px;color:{INK};font-family:{SANS}">'
      '<tr><th style="width:42%;text-align:left">If this happens</th><th style="width:58%;text-align:left">Plan B</th></tr>' +
      "".join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a, b in rk) + "</table>")
slides["risks"] = section("risks", LIGHT,
    head("Risks", "Every bet has a fallback.") + rt + foot(17),
    "The riskiest assumption is that platforms will let a third party decide disputes; the second is that AI judges can be trusted with real money. Both are tested in the pilot before any scale-up.")

# 18 ask ------------------------------------------------------------------------------
use = "".join(f'<tr><td>{a}</td><td style="text-align:right">{b}</td></tr>' for a, b in [
    ("Pilot integration and partner support", "[__%]"),
    ("Legal, escrow partner and compliance", "[__%]"),
    ("Production: database, per-user keys, authentication", "[__%]"),
    ("Judges from separate model providers, human arbitration", "[__%]")])
slides["ask"] = section("ask", LIGHT,
    head("The ask", "[Raise amount] to reach a paid pilot in [12] months.") +
    '<div style="display:flex;gap:48px">'
    f'<div style="flex:1;display:flex;flex-direction:column;gap:16px">{h3("Use of funds", 32)}'
    f'<table style="font-size:27px;color:{INK};font-family:{SANS}"><tr><th style="width:80%;text-align:left">Area</th><th style="width:20%;text-align:right">Share</th></tr>{use}</table></div>' +
    card(h3("By the end of the round", 32) + "".join(p("• " + x, 27) for x in [
        "One paid pilot live", "[__] deals through escrow", "Judge–human agreement measured", "First market chosen on data"]), ";width:640px") +
    "</div>" +
    p("<b>Team:</b> [Founder name, role] · [Founder name, role] · [advisers]", 28, INK) + foot(18),
    "Fill in the raise, the timeline and the team before sending. Keep the milestones concrete: one paid pilot and measured judge accuracy are what the next round will be priced on.")

# 19 close -------------------------------------------------------------------------------
slides["close"] = section("close",
    f"background:{INK};color:{PAPER};font-family:{SANS};padding:128px;display:flex;flex-direction:column;justify-content:center;gap:48px",
    f'<h2 style="font-size:96px;font-weight:600;line-height:1.1;color:{PAPER};width:1500px">Any AI can negotiate. Tribunal makes the deal safe to accept.</h2>'
    f'<p style="font-size:32px;color:#B8C2D6">[Founder names] · [contact email] · [website]</p>',
    "Close on the one line. Then open the live simulation or take questions.")

order = ["cover", "problem", "trustgap", "whynow", "solution", "insight", "scenarios", "proof", "fairness", "demos",
         "market", "competition", "moat", "model", "gtm", "roadmap", "risks", "ask", "close"]
for k in order:
    open(f"{ROOT}/slides/{k}.html", "w").write(slides[k])

deck = {
    "v": 4, "createdOnFiles": {"v": 1, "at": "2026-11-10T09:45:00Z"}, "lists": "css",
    "title": "Tribunal Pitch", "cover": "cover", "order": order,
    "sections": {
        "s1": {"description": "Who we are in one line", "start": "cover"},
        "s2": {"description": "Agents can deal, but nobody trusts their deals yet", "start": "problem"},
        "s3": {"description": "The product: deciding is separated from talking", "start": "solution"},
        "s4": {"description": "Proof from two working prototypes", "start": "proof"},
        "s5": {"description": "Market, competition and why we win", "start": "market"},
        "s6": {"description": "How we make money and get to a pilot", "start": "model"},
        "s7": {"description": "The ask", "start": "ask"},
    },
    "faces": {
        "ibm-plex-sans": {"family": "IBM Plex Sans", "href": "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"},
        "ibm-plex-mono": {"family": "IBM Plex Mono", "href": "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap"},
    },
    "designSystems": [],
}
open(f"{ROOT}/deck.json", "w").write(json.dumps(deck, ensure_ascii=False, indent=1))
print("ok", len(order))
