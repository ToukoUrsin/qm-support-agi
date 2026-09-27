import { html, nothing, render, svg, type TemplateResult } from "lit";
import { Route } from "lucide";
import "./paths.css";
import { api, fetchTranscript, type SessionEntry } from "./core-bridge";
import { mainConversation } from "./conversations";
import { focusedPaneConversation } from "./split";
import { sessionsState } from "./sessions";
import { registerPaneKind } from "./pane-kinds";
import { icon } from "./ui";
import { swallow } from "../../chassis/src/errors";

export const PathsGlyph = Route;

interface ToolStep {
  name: string;
  ms: number | null;
  error: boolean;
  result: string;
}

interface Turn {
  seq: number;
  startedAt: number;
  endedAt: number;
  running: boolean;
  tools: ToolStep[];
  mode: "recalled" | "explored" | "none";
  savedPath: boolean;
  costUsd: number | null;
}

interface ReplayRow {
  id?: string;
  intent?: string;
  recalled?: boolean;
  steps?: number;
  ms?: number;
  tokens?: number;
  cost?: number;
  library?: number;
}

const KNOWN_TOOLS = [
  "recall_path",
  "save_path",
  "search_kb",
  "read_page",
  "find_orders",
  "get_order",
  "refund_order",
  "update_address",
  "cancel_order",
  "send_reply",
  "route_request",
  "pull_up_account",
  "verify_identity",
  "validate_purchase",
  "shipping_status",
  "check_system",
  "membership",
  "subscription_status",
  "record_reason",
  "enter_details",
  "offer_refund",
  "update_order",
  "update_account",
  "update_subscription",
  "make_purchase",
  "make_password",
  "promo_code",
  "send_link",
  "notify_team",
  "troubleshoot_step",
  "get_refunds",
  "list_products",
];

function shortTool(name: string): string {
  for (const t of KNOWN_TOOLS) if (name === t || name.endsWith(`_${t}`) || name.endsWith(`__${t}`)) return t;
  return name.replace(/^mcp__[^_]+__/, "");
}

function payloadOf(e: SessionEntry): Record<string, unknown> {
  return e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {};
}

function resultText(p: Record<string, unknown>): string {
  const r = p.result ?? p.output ?? p.stdout ?? "";
  return typeof r === "string" ? r : JSON.stringify(r);
}

function recallHit(step: ToolStep | undefined): boolean {
  if (!step || step.name !== "recall_path" || step.error) return false;
  const t = step.result.trim();
  if (!t || /^(null|\[\]|\{\}|""|none)$/i.test(t)) return false;
  return !/(no (matching |similar |saved )?paths?|not found|no match|"found"\s*:\s*false|"path"\s*:\s*null|miss)/i.test(
    t,
  );
}

function buildTurns(entries: SessionEntry[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const calls = new Map<string, { turn: Turn; idx: number; at: number }>();
  for (const e of entries) {
    if (e.type === "user") {
      cur = {
        seq: e.seq ?? 0,
        startedAt: e.createdAt,
        endedAt: e.createdAt,
        running: true,
        tools: [],
        mode: "none",
        savedPath: false,
        costUsd: null,
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.endedAt = Math.max(cur.endedAt, e.createdAt);
    const p = payloadOf(e);
    if (e.type === "tool_call") {
      const name = shortTool(String(p.tool ?? p.name ?? "tool"));
      cur.tools.push({ name, ms: null, error: false, result: "" });
      calls.set(String(p.callId ?? `${cur.seq}:${cur.tools.length}`), {
        turn: cur,
        idx: cur.tools.length - 1,
        at: e.createdAt,
      });
    } else if (e.type === "tool_result") {
      const hit = calls.get(String(p.callId ?? ""));
      if (hit) {
        const step = hit.turn.tools[hit.idx]!;
        step.ms = Math.max(0, e.createdAt - hit.at);
        step.error = p.isError === true;
        step.result = resultText(p);
      }
    }
  }
  const last = entries.at(-1);
  turns.forEach((t, i) => {
    t.running = i === turns.length - 1 && last?.type !== "assistant" && Date.now() - t.endedAt < 120_000;
  });
  // A follow-up turn without its own recall_path (e.g. the customer answering a question) continues the
  // ticket's earlier mode instead of counting as a fresh exploration.
  let prev: Turn["mode"] = "none";
  for (const t of turns) {
    const recall = t.tools.find((s) => s.name === "recall_path");
    if (t.tools.length === 0) t.mode = "none";
    else if (recall) t.mode = recallHit(recall) ? "recalled" : "explored";
    else t.mode = prev === "none" ? "explored" : prev;
    if (t.mode !== "none") prev = t.mode;
    t.savedPath = t.tools.some((s) => s.name === "save_path" && !s.error);
  }
  return turns;
}

interface LlmReq {
  turnSeq: number | null;
  createdAt: number;
  usage: { costUsd?: number } | null;
}

async function fetchTurnCosts(sessionId: string, scopeId: string, turns: Turn[]): Promise<void> {
  const qs = new URLSearchParams({ scope: scopeId });
  const r = await fetch(`/admin/api/sessions/${encodeURIComponent(sessionId)}/llm?${qs}`, { credentials: "include" });
  if (!r.ok) return;
  const body = (await r.json()) as { requests?: LlmReq[] };
  const reqs = body.requests ?? [];
  const bySeq = reqs.some((q) => q.turnSeq != null);
  turns.forEach((t, i) => {
    const next = turns[i + 1];
    const mine = reqs.filter((q) =>
      bySeq && q.turnSeq != null
        ? q.turnSeq >= t.seq && (!next || q.turnSeq < next.seq)
        : q.createdAt >= t.startedAt && (!next || q.createdAt < next.startedAt),
    );
    if (mine.length) t.costUsd = mine.reduce((s, q) => s + (q.usage?.costUsd ?? 0), 0);
  });
}

const state = {
  sessionId: null as string | null,
  sessionTitle: "",
  turns: [] as Turn[],
  replay: [] as ReplayRow[],
  replaySource: null as string | null,
  error: "",
};
const hosts = new Set<HTMLElement>();
let timer: number | null = null;
let replayTick = 0;
let lastFocused: string | null = null;

function currentSessionId(): string | null {
  const conv = focusedPaneConversation() ?? mainConversation();
  const id = conv.state.sessionId;
  if (id) lastFocused = id;
  if (lastFocused) return lastFocused;
  const latest = [...sessionsState.list].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  return latest?.id ?? null;
}

async function poll(): Promise<void> {
  try {
    if (replayTick++ % 4 === 0) {
      const r = await api<{ source: string | null; rows: ReplayRow[] }>("/api/replay/results");
      state.replay = r.rows;
      state.replaySource = r.source;
    }
    const id = currentSessionId();
    state.sessionId = id;
    if (id) {
      const page = await fetchTranscript(id, { tailTurns: 6 });
      state.sessionTitle = page.session?.title ?? "";
      const turns = buildTurns(page.entries);
      await fetchTurnCosts(
        id,
        page.session?.scopeId ?? sessionsState.list.find((row) => row.id === id)?.scopeId ?? "",
        turns,
      ).catch(() => undefined);
      state.turns = turns;
    } else {
      state.turns = [];
    }
    state.error = "";
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  drawAll();
}

function ensurePolling(): void {
  if (timer !== null) return;
  void poll();
  timer = window.setInterval(() => void poll(), 1500);
}

function stopPollingIfIdle(): void {
  if (hosts.size || timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtUsd = (v: number): string => (v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);

function badge(mode: Turn["mode"], running: boolean): TemplateResult {
  if (mode === "recalled") return html`<span class="paths-badge recalled">Recalled path</span>`;
  if (mode === "explored") return html`<span class="paths-badge explored">Explored</span>`;
  return html`<span class="paths-badge idle">${running ? "Thinking…" : "No tools"}</span>`;
}

function turnCard(t: Turn): TemplateResult {
  const elapsed = (t.running ? Date.now() : t.endedAt) - t.startedAt;
  return html`<section class="paths-card paths-live">
    <div class="paths-card-head">
      ${badge(t.mode, t.running)} ${t.savedPath ? html`<span class="paths-chip">+ saved new path</span>` : nothing}
      ${t.running ? html`<span class="paths-running">live</span>` : nothing}
    </div>
    <div class="paths-kpis">
      <div><b>${fmtMs(elapsed)}</b><span>turn time</span></div>
      <div><b>${t.costUsd == null ? "—" : fmtUsd(t.costUsd)}</b><span>cost</span></div>
      <div><b>${t.tools.length}</b><span>tool calls</span></div>
    </div>
    <ol class="paths-steps">
      ${t.tools.map(
        (s) =>
          html`<li class=${s.error ? "err" : ""}>
            <code>${s.name}</code><span class="paths-ms">${s.ms == null ? "…" : fmtMs(s.ms)}</span>
          </li>`,
      )}
    </ol>
  </section>`;
}

const MODE_LABEL: Record<Turn["mode"], string> = { recalled: "Recalled", explored: "Explored", none: "—" };

function historyRow(t: Turn): TemplateResult {
  return html`<li>
    <span class="paths-dot ${t.mode}"></span>
    <span class="paths-hist-mode">${MODE_LABEL[t.mode]}</span>
    <span>${t.tools.length} calls</span>
    <span>${fmtMs(t.endedAt - t.startedAt)}</span>
    <span>${t.costUsd == null ? "—" : fmtUsd(t.costUsd)}</span>
  </li>`;
}

function rolling(values: number[], w: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - w + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function curveChart(rows: ReplayRow[]): TemplateResult {
  const W = 520;
  const H = 220;
  const pad = { l: 44, r: 70, t: 14, b: 28 };
  const n = rows.length;
  const cost = rows.map((r) => r.cost ?? 0);
  const steps = rows.map((r) => r.steps ?? 0);
  const maxCost = Math.max(...cost, 0.0001) * 1.08;
  const maxSteps = Math.max(...steps, 1) * 1.08;
  const x = (i: number): number => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const yc = (v: number): number => pad.t + (1 - v / maxCost) * (H - pad.t - pad.b);
  const ys = (v: number): number => pad.t + (1 - v / maxSteps) * (H - pad.t - pad.b);
  const costAvg = rolling(cost, 5);
  const stepAvg = rolling(steps, 5);
  const line = (vals: number[], y: (v: number) => number): string =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1].map((f) => f * maxCost);
  return html`<svg class="paths-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost and tool calls per ticket">
    ${ticks.map(
      (v) => svg`<line class="grid" x1=${pad.l} x2=${W - pad.r} y1=${yc(v)} y2=${yc(v)}></line>
        <text class="axis" x=${pad.l - 6} y=${yc(v) + 4} text-anchor="end">$${v.toFixed(2)}</text>`,
    )}
    <text class="axis" x=${pad.l} y=${H - 8}>1</text>
    <text class="axis" x=${W - pad.r} y=${H - 8} text-anchor="end">ticket ${n}</text>
    ${rows.map(
      (r, i) =>
        svg`<circle class="pt ${r.recalled ? "recalled" : "explored"}" cx=${x(i)} cy=${yc(cost[i]!)} r="3"></circle>`,
    )}
    <path class="line-steps" d=${line(stepAvg, ys)}></path>
    <path class="line-cost" d=${line(costAvg, yc)}></path>
    <text class="lbl-cost" x=${x(n - 1) + 6} y=${yc(costAvg[n - 1]!) + 4}>${fmtUsd(costAvg[n - 1]!)}</text>
    <text class="lbl-steps" x=${x(n - 1) + 6} y=${ys(stepAvg[n - 1]!) + 4}>${stepAvg[n - 1]!.toFixed(1)} calls</text>
  </svg>`;
}

function curveSection(): TemplateResult {
  const rows = state.replay;
  if (!rows.length)
    return html`<section class="paths-card">
      <h3>Learning curve</h3>
      <p class="paths-empty">Waiting for replay/results.jsonl…</p>
    </section>`;
  const n = rows.length;
  const recalled = rows.filter((r) => r.recalled).length;
  const library = rows.at(-1)?.library ?? new Set(rows.filter((r) => !r.recalled).map((r) => r.intent ?? r.id)).size;
  const k = Math.min(10, Math.max(1, Math.floor(n / 3)));
  const avg = (rs: ReplayRow[]): number => rs.reduce((s, r) => s + (r.cost ?? 0), 0) / rs.length;
  const first = avg(rows.slice(0, k));
  const last = avg(rows.slice(-k));
  const drop = first > 0 ? Math.round((1 - last / first) * 100) : 0;
  return html`<section class="paths-card">
    <h3>
      Learning curve
      ${state.replaySource && state.replaySource !== "results.jsonl" ? html`<span class="paths-chip">sample data</span>` : nothing}
    </h3>
    <div class="paths-kpis big">
      <div><b>${n}</b><span>tickets</span></div>
      <div><b>${library}</b><span>path library</span></div>
      <div><b>${Math.round((recalled / n) * 100)}%</b><span>recalled</span></div>
      <div>
        <b class=${drop > 0 ? "good" : ""}>${drop > 0 ? "−" : "+"}${Math.abs(drop)}%</b><span>cost/ticket</span>
      </div>
    </div>
    ${curveChart(rows)}
    <div class="paths-legend">
      <span><i class="sw cost"></i>cost per ticket (5-ticket avg)</span>
      <span><i class="sw steps"></i>tool calls per ticket</span>
      <span><i class="sw dot recalled"></i>recalled</span>
      <span><i class="sw dot explored"></i>explored</span>
    </div>
    <p class="paths-foot">First ${k}: ${fmtUsd(first)}/ticket · last ${k}: ${fmtUsd(last)}/ticket</p>
  </section>`;
}

function panelTpl(onClose?: () => void): TemplateResult {
  const latest = state.turns.at(-1);
  const earlier = state.turns.slice(0, -1).reverse();
  return html`<div class="paths-panel">
    <header class="paths-head">
      ${icon(Route, 18)}
      <h2>Paths</h2>
      <span class="paths-session" title=${state.sessionId ?? ""}
        >${state.sessionTitle || (state.sessionId ? "current session" : "no session")}</span
      >
      ${onClose ? html`<button class="paths-close" type="button" aria-label="Close Paths" @click=${onClose}>×</button>` : nothing}
    </header>
    ${latest ? turnCard(latest) : html`<section class="paths-card"><p class="paths-empty">Send a ticket to see its path.</p></section>`}
    ${
      earlier.length
        ? html`<ul class="paths-history">
            ${earlier.map(historyRow)}
          </ul>`
        : nothing
    }
    ${curveSection()} ${state.error ? html`<p class="paths-error">${state.error}</p>` : nothing}
  </div>`;
}

const closers = new WeakMap<HTMLElement, () => void>();

function drawAll(): void {
  for (const h of hosts) render(panelTpl(closers.get(h)), h);
}

function mountPaths(host: HTMLElement, onClose?: () => void): { dispose(): void } {
  hosts.add(host);
  if (onClose) closers.set(host, onClose);
  host.classList.add("paths-host");
  render(panelTpl(onClose), host);
  ensurePolling();
  return {
    dispose() {
      hosts.delete(host);
      render(nothing, host);
      host.classList.remove("paths-host");
      stopPollingIfIdle();
    },
  };
}

let drawer: { el: HTMLElement; handle: { dispose(): void } } | null = null;
const OPEN_KEY = "qm-paths-open";

export function pathsDrawerOpen(): boolean {
  return drawer !== null;
}

export function togglePathsDrawer(open = !drawer): void {
  if (open && !drawer) {
    const el = document.createElement("aside");
    el.className = "paths-drawer";
    document.body.appendChild(el);
    drawer = { el, handle: mountPaths(el, () => togglePathsDrawer(false)) };
    document.body.classList.add("paths-open");
  } else if (!open && drawer) {
    drawer.handle.dispose();
    drawer.el.remove();
    drawer = null;
    document.body.classList.remove("paths-open");
  }
  try {
    localStorage.setItem(OPEN_KEY, drawer ? "1" : "0");
  } catch (e) {
    swallow("paths: persist drawer state", e);
  }
  window.dispatchEvent(new Event("paths-drawer-change"));
}

function restoreDrawer(): void {
  let want = /[?&#]paths\b/.test(location.search + location.hash);
  try {
    want ||= localStorage.getItem(OPEN_KEY) === "1";
  } catch (e) {
    swallow("paths: read drawer state", e);
  }
  if (want) togglePathsDrawer(true);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreDrawer);
else queueMicrotask(restoreDrawer);

registerPaneKind({
  paramsKey: "pathsView",
  glyph: Route,
  title: () => "Paths",
  badge: () => 0,
  mount: ({ host }) => mountPaths(host),
  maximize: () => togglePathsDrawer(true),
});
