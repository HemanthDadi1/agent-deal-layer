"""Build the two self-contained web pages from src/.

    python web/build.py     ->  web/dist/demo.html, web/dist/simulation.html

The negotiation engine (src/engine.js) is a line-for-line port of poc/agentdeal/engine.py
and the dispute rules in poc/agentdeal/ledger.py. src/sim.js is the market simulation.
"""
import re
from pathlib import Path

SRC = Path(__file__).parent / "src"
DIST = Path(__file__).parent / "dist"


def strip_node_export(js: str) -> str:
    return re.sub(r"if \(typeof module[^\n]*\n", "", js)


def main():
    DIST.mkdir(exist_ok=True)
    engine = strip_node_export((SRC / "engine.js").read_text())
    sim = strip_node_export((SRC / "sim.js").read_text())
    demo = (SRC / "demo.template.html").read_text().replace("/*__ENGINE__*/", engine)
    simulation = (SRC / "simulation.template.html").read_text().replace("/*__ENGINE__*/", engine).replace("/*__SIM__*/", sim)
    (DIST / "demo.html").write_text(demo)
    (DIST / "simulation.html").write_text(simulation)
    print("built", DIST / "demo.html", "and", DIST / "simulation.html")


if __name__ == "__main__":
    main()
