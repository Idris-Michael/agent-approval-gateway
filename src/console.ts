// Read-only operator console served at "/". Decisions are made on the approver's phone; this
// page shows what is waiting, what was decided by whom, and whether the audit chain verifies.
// All data is written with textContent, never innerHTML, so card text can't inject markup.

export function consolePage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approval console</title>
<style nonce="${nonce}">
:root {
  --bg: #f4f2ec; --surface: #fffdf8; --ink: #17140f; --muted: #6b665c; --line: #d9d4c7;
  --accent: #e2481b; --ok: #2f7a4d; --warn: #a86a00; --bad: #b3261e;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
  --sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14130f; --surface: #1c1a16; --ink: #f1ede3; --muted: #a39d90; --line: #34302a;
          --accent: #ff6a3d; --ok: #5cc28a; --warn: #e0a83a; --bad: #ff7a70; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); }
.rail { position: fixed; inset: 0 auto 0 0; width: 6px; background: var(--accent); }
main { max-width: 1120px; margin: 0 auto; padding: 40px 24px 64px 32px; }
.eyebrow { font: 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: clamp(28px, 4vw, 44px); line-height: 1.05; margin: 10px 0 6px; letter-spacing: -.02em; }
h1 span { color: var(--accent); }
.lede { color: var(--muted); margin: 0 0 28px; max-width: 60ch; }
.bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;
       border-top: 2px solid var(--ink); border-bottom: 1px solid var(--line); padding: 12px 0; margin-bottom: 8px; }
.tabs { display: flex; gap: 4px; }
.tabs button { font: 13px var(--mono); padding: 6px 12px; border: 1px solid var(--line); background: transparent;
               color: var(--ink); cursor: pointer; border-radius: 2px; }
.tabs button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.tabs button:focus-visible, form button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.audit { font: 12px var(--mono); display: flex; gap: 8px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.audit[data-ok="true"] .dot { background: var(--ok); }
.audit[data-ok="false"] .dot { background: var(--bad); }
.audit[data-ok="false"] { color: var(--bad); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font: 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
     padding: 10px 12px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 14px 12px 14px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td.tool { font-weight: 600; }
td.args { font: 12.5px/1.6 var(--mono); white-space: pre-wrap; color: var(--ink); max-width: 360px; }
td.meta { font: 12px var(--mono); color: var(--muted); white-space: nowrap; }
.pill { display: inline-block; font: 11px/1 var(--mono); padding: 5px 8px; border-radius: 2px; border: 1px solid currentColor; text-transform: uppercase; letter-spacing: .05em; }
.pill.pending { color: var(--accent); }
.pill.executing { color: var(--warn); }
.pill.done { color: var(--ok); }
.pill.rejected, .pill.expired { color: var(--muted); }
.pill.failed { color: var(--bad); }
.outcome { margin-top: 6px; font-size: 13px; color: var(--muted); }
.empty { padding: 48px 0; color: var(--muted); text-align: center; }
form { display: flex; gap: 8px; flex-wrap: wrap; margin: 24px 0; }
input { flex: 1 1 280px; font: 14px var(--mono); padding: 10px 12px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
form button { font: 13px var(--mono); padding: 10px 16px; background: var(--accent); color: #fff; border: 0; cursor: pointer; }
.error { color: var(--bad); font: 13px var(--mono); }
@media (max-width: 720px) {
  thead { display: none; }
  tr { display: block; border-bottom: 1px solid var(--line); padding: 10px 0; }
  td { display: block; border: 0; padding: 4px 0; }
}
</style>
</head>
<body>
<div class="rail" aria-hidden="true"></div>
<main>
  <div class="eyebrow">Agent approval gateway</div>
  <h1>Approval <span>console</span></h1>
  <p class="lede">Every action an agent proposes that the policy marks as sensitive waits here until a named approver decides on their phone. This view is read-only.</p>

  <form id="login" hidden>
    <input id="key" type="password" autocomplete="off" placeholder="Viewer API key" aria-label="Viewer API key" required>
    <button type="submit">Open console</button>
  </form>

  <section id="app" hidden>
    <div class="bar">
      <div class="tabs" role="group" aria-label="Filter">
        <button type="button" data-filter="pending" aria-pressed="true">Pending</button>
        <button type="button" data-filter="" aria-pressed="false">All</button>
        <button type="button" data-filter="failed" aria-pressed="false">Failed</button>
      </div>
      <div class="audit" id="audit" role="status"><span class="dot"></span><span id="auditText">Checking audit chain</span></div>
    </div>
    <table>
      <thead><tr><th>Status</th><th>Tool</th><th>Arguments</th><th>Requested</th><th>Decided by</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p class="empty" id="empty" hidden>Nothing here.</p>
  </section>
  <p class="error" id="error" role="alert"></p>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  let key = null;
  try { key = sessionStorage.getItem("viewerKey"); } catch {}
  let filter = "pending";

  const api = async (path) => {
    const res = await fetch(path, { headers: { authorization: "Bearer " + key } });
    if (res.status === 401 || res.status === 403) { signOut("That key can't open the console."); throw new Error("auth"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const argsText = (args) => Object.keys(args).sort().map((k) => k + ": " + (typeof args[k] === "string" ? args[k] : JSON.stringify(args[k]))).join("\\n") || "(none)";

  function render(list) {
    const body = $("rows");
    body.replaceChildren();
    $("empty").hidden = list.length > 0;
    for (const a of list) {
      const tr = document.createElement("tr");
      const st = el("td"); st.append(el("span", "pill " + a.status, a.status)); tr.append(st);
      const tool = el("td", "tool", a.tool);
      if (a.outcome) tool.append(el("div", "outcome", a.outcome));
      tr.append(tool);
      tr.append(el("td", "args", argsText(a.args)));
      tr.append(el("td", "meta", when(a.createdAt) + "\\nexpires " + when(a.expiresAt)));
      tr.append(el("td", "meta", a.decidedBy || "-"));
      body.append(tr);
    }
  }

  async function refresh() {
    try {
      const q = filter ? "?status=" + filter : "";
      const [{ approvals }, audit] = await Promise.all([api("/v1/approvals" + q), api("/v1/audit").catch(() => null)]);
      render(approvals);
      const box = $("audit");
      if (audit) {
        box.dataset.ok = String(audit.ok);
        $("auditText").textContent = audit.ok
          ? "Audit chain verified · " + audit.entries + " entries · head " + audit.headHash.slice(0, 10)
          : "Audit chain BROKEN at line " + audit.brokenAtLine + ": " + audit.reason;
      } else {
        $("auditText").textContent = "Audit log not configured";
      }
      $("error").textContent = "";
    } catch (e) {
      if (e.message !== "auth") $("error").textContent = "Could not load: " + e.message;
    }
  }

  function signOut(message) {
    try { sessionStorage.removeItem("viewerKey"); } catch {}
    key = null;
    $("app").hidden = true;
    $("login").hidden = false;
    $("error").textContent = message || "";
  }

  let timer = null;
  function start() {
    $("login").hidden = true;
    $("app").hidden = false;
    refresh();
    if (!timer) timer = setInterval(refresh, 5000);
  }

  $("login").addEventListener("submit", (e) => {
    e.preventDefault();
    key = $("key").value.trim();
    try { sessionStorage.setItem("viewerKey", key); } catch {}
    start();
  });

  for (const b of document.querySelectorAll("[data-filter]")) {
    b.addEventListener("click", () => {
      filter = b.dataset.filter;
      for (const o of document.querySelectorAll("[data-filter]")) o.setAttribute("aria-pressed", String(o === b));
      refresh();
    });
  }

  if (key) start(); else $("login").hidden = false;
})();
</script>
</body>
</html>`;
}
