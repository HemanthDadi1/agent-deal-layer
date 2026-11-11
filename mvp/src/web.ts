export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
export const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function layout(title: string, body: string, nav = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Agent Deal Layer</title><style>
:root{--ink:#1a1f2b;--mut:#5b6472;--line:#dde1e8;--brand:#1f3864;--ok:#1d7a4d;--bad:#b3322a;--bg:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--brand);color:#fff;padding:12px 20px;display:flex;gap:18px;align-items:center}header a{color:#fff;text-decoration:none;opacity:.9}header b{font-size:17px}
main{max-width:980px;margin:22px auto;padding:0 16px}h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:24px 0 8px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}th{background:#eef1f6}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;width:100%;margin:4px 0 10px}
button,.btn{font:inherit;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block}
button.alt{background:#fff;color:var(--brand);border:1px solid var(--brand)}button.bad{background:var(--bad)}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;background:#e6ecf7;font-size:12px}.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut)}
.notice{background:#fff8e6;border:1px solid #f0d58a;border-radius:8px;padding:10px 12px;margin:12px 0}
form.inline{display:inline}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}
</style></head><body><header><b>Agent Deal Layer</b>${nav}</header><main>${body}</main></body></html>`;
}
