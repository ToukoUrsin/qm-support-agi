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
  modelCalls: number | null;
}

interface ReplayRow {
  id?: string;
  intent?: string;
  recalled?: boolean;
  steps?: number;
  ms?: number;
  tokens?: number;
  cost?: number;
  normCost?: number;
  library?: number;
  tier?: string;
  error?: string;
}

interface Plan {
  id: string;
  enabled?: boolean;
  source?: { procedureId?: string };
  [k: string]: unknown;
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
        modelCalls: null,
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
    t.modelCalls = mine.length;
    if (mine.length) t.costUsd = mine.reduce((s, q) => s + (q.usage?.costUsd ?? 0), 0);
  });
}

// ?run=label-run pins the learning curve to the finished snapshot run (the SPA drops the query after load).
const SNAPSHOT = /[?&]run=label-run\b/.test(location.search);

const state = {
  sessionId: null as string | null,
  sessionTitle: "",
  turns: [] as Turn[],
  replay: [] as ReplayRow[],
  replaySource: null as string | null,
  plans: [] as Plan[],
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
      const r = await api<{ source: string | null; rows: ReplayRow[] }>(
        `/api/replay/results${SNAPSHOT ? "?run=label-run" : ""}`,
      );
      state.replay = r.rows;
      state.replaySource = r.source;
      state.plans = (await api<{ plans: Plan[] }>("/api/replay/plans").catch(() => ({ plans: [] }))).plans;
    }
    const id = currentSessionId();
    state.sessionId = id;
    if (id) {
      const page = await fetchTranscript(id, { tailTurns: 8 });
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

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtUsd = (v: number): string => (v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);

interface Recall {
  found: boolean;
  id?: string;
  title?: string;
  similarity?: number;
  normalized?: string;
  normalizer?: string;
  backend?: string;
  steps?: string[];
  tools?: string[];
  uses?: number;
  closest?: string | null;
  planId?: string;
  compiled?: boolean;
  ms?: number;
  earlierTickets?: { id: string; text: string; tier?: string }[];
}

function parseJsonish(text: string): Record<string, unknown> | null {
  const tryParse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  let v: unknown = tryParse(text);
  for (let i = 0; i < 4 && v != null; i++) {
    if (typeof v === "string") v = tryParse(v);
    else if (Array.isArray(v)) v = v.find((c) => c && typeof c === "object" && "text" in c)?.text ?? v[0];
    else if (typeof v === "object" && "content" in (v as object)) v = (v as { content: unknown }).content;
    else if (typeof v === "object" && "text" in (v as object) && !("found" in (v as object)))
      v = (v as { text: unknown }).text;
    else break;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  const m = text.indexOf('{\\"found');
  if (m >= 0) return parseJsonish(`"${text.slice(m).replace(/"\s*\}\s*\]?\s*\}?\s*$/, "")}"`);
  return null;
}

function recallOf(turns: Turn[]): Recall | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const step = turns[i]!.tools.find((s) => s.name === "recall_path");
    if (step && step.result) {
      const r = parseJsonish(step.result);
      if (r && "found" in r) return r as unknown as Recall;
      return { found: recallHit(step) };
    }
  }
  return null;
}

function savedOf(t: Turn): { id?: string; title?: string } | null {
  const step = t.tools.find((s) => s.name === "save_path" && !s.error);
  if (!step) return null;
  const r = parseJsonish(step.result);
  return r ? { id: r.id as string | undefined, title: r.title as string | undefined } : {};
}

type Host = "River" | "Memorable" | "GBrain" | "Shopify" | "QM";
function hostOf(tool: string): Host {
  if (tool === "recall_path" || tool === "save_path") return "Memorable";
  if (tool === "search_kb" || tool === "read_page") return "GBrain";
  if (tool === "route_request" || tool === "send_reply" || tool === "notify_team") return "QM";
  return "Shopify";
}
const hostTag = (h: Host): TemplateResult => html`<span class="pb-host h-${h.toLowerCase()}">${h}</span>`;

const toolOfStep = (s: string): string => s.trim().split(/[\s(]/)[0] ?? s;

// The current ticket = the latest turn plus earlier follow-up turns back to the one that called recall_path.
function ticketTurns(turns: Turn[]): Turn[] {
  let start = turns.length - 1;
  while (start > 0 && !turns[start]!.tools.some((s) => s.name === "recall_path")) start--;
  return turns.slice(Math.max(0, start));
}

type Tier = "explored" | "recalled" | "compiled";

function tierBadge(tier: Tier | "none", running: boolean): TemplateResult {
  if (tier === "compiled")
    return html`<div class="pb-tier compiled"><b>COMPILED</b><span>no model calls, fixed program</span></div>`;
  if (tier === "recalled")
    return html`<div class="pb-tier recalled"><b>RECALLED PATH</b><span>reused a learned path</span></div>`;
  if (tier === "explored")
    return html`<div class="pb-tier explored"><b>EXPLORED</b><span>solved from scratch</span></div>`;
  return html`<div class="pb-tier idle"><b>${running ? "Working…" : "Waiting for a ticket"}</b></div>`;
}

function planFor(r: Recall | null): Plan | undefined {
  if (!r) return undefined;
  return state.plans.find((p) => (r.planId && p.id === r.planId) || (r.id && p.source?.procedureId === r.id));
}

function comparison(pathTools: string[], calls: ToolStep[]): TemplateResult {
  const run = calls.filter((c) => c.name !== "recall_path" && c.name !== "save_path");
  const ran = new Set(run.map((c) => c.name));
  const skipped = pathTools.filter((t) => !ran.has(t));
  const inPath = new Set(pathTools);
  return html`<div class="pb-compare">
      <div>
        <h4>Learned path</h4>
        <ol class="pb-list">
          ${pathTools.map((t) => html`<li class=${ran.has(t) ? "ok" : "skip"}><code>${t}</code>${hostTag(hostOf(t))}</li>`)}
        </ol>
      </div>
      <div>
        <h4>This ticket</h4>
        <ol class="pb-list">
          ${run.map(
            (c) =>
              html`<li class=${c.error ? "err" : inPath.has(c.name) ? "ok" : "extra"}>
                <span class="pb-mark">${c.error ? "!" : inPath.has(c.name) ? "✓" : "+"}</span
                ><code>${c.name}</code>${hostTag(hostOf(c.name))}<span class="pb-ms"
                  >${c.ms == null ? "…" : fmtMs(c.ms)}</span
                >
              </li>`,
          )}
          ${skipped.map((t) => html`<li class="skip"><span class="pb-mark">–</span><code>${t}</code>${hostTag(hostOf(t))}<span class="pb-ms">skipped</span></li>`)}
        </ol>
      </div>
    </div>
    <p class="pb-legend">
      <span class="ok">✓ followed the path</span><span class="extra">+ extra call</span
      ><span class="skip">– skipped</span>
    </p>`;
}

function ticketSection(): TemplateResult {
  if (!state.turns.length)
    return html`<section class="pb-card"><p class="pb-empty">Send a ticket to see how it was handled.</p></section>`;
  const tt = ticketTurns(state.turns);
  const calls = tt.flatMap((t) => t.tools);
  const running = tt.at(-1)!.running;
  const r = recallOf(tt);
  const plan = planFor(r);
  const compiled = !!r?.planId || tt.every((t) => t.tools.length > 0 && t.costUsd === 0);
  const tier: Tier | "none" = !calls.length ? "none" : compiled ? "compiled" : r?.found ? "recalled" : "explored";
  const saved = tt.map(savedOf).find(Boolean);
  const elapsed = tt.reduce((s, t) => s + ((t.running ? Date.now() : t.endedAt) - t.startedAt), 0);
  const cost = tt.some((t) => t.costUsd != null) ? tt.reduce((s, t) => s + (t.costUsd ?? 0), 0) : null;
  const pathTools = r?.tools?.length ? r.tools : (r?.steps ?? []).map(toolOfStep);
  const uses = r?.uses;
  return html`<section class="pb-card">
    <div class="pb-row">${tierBadge(tier, running)} ${running ? html`<span class="pb-live">live</span>` : nothing}</div>
    ${
      r?.compiled
        ? html`<div class="pb-kpis">
            <div><b>${fmtMs(r.ms ?? elapsed)}</b><span>time</span></div>
            <div><b>$0.00</b><span>cost</span></div>
            <div><b>0</b><span>model calls</span></div>
            <div><b>${calls.length - 1}</b><span>tool calls</span></div>
          </div>`
        : html`<div class="pb-kpis">
            <div><b>${fmtMs(elapsed)}</b><span>time</span></div>
            <div><b>${cost == null ? "—" : fmtUsd(cost)}</b><span>cost</span></div>
            <div><b>${calls.length}</b><span>tool calls</span></div>
          </div>`
    }
    ${
      r?.normalized
        ? html`<div class="pb-block">
            <h4>Standardized request ${hostTag("River")}</h4>
            <p class="pb-quote">${r.normalized}</p>
            ${r.normalizer === "river" ? html`<p class="pb-meta">standardized by <b>River</b></p>` : nothing}
          </div>`
        : nothing
    }

    <div class="pb-block">
      <h4>Matched to</h4>
      ${
        r?.compiled
          ? html`<p class="pb-match"><b>Compiled plan</b> <code class="pb-id">${r.planId}</code></p>
              <p class="pb-meta">
                ${(r.tools ?? []).join(" → ")} · <b>${fmtMs(r.ms ?? 0)}</b> · <b>0 model calls</b> · deterministic
                program, no LLM
              </p>`
          : r?.found
            ? html`<p class="pb-match"><b>${r.title ?? "learned path"}</b> <code class="pb-id">${r.id ?? ""}</code></p>
                <p class="pb-meta">
                  ${r.similarity != null ? html`similarity <b>${r.similarity.toFixed(2)}</b> · ` : nothing}found in
                  <b>${!r.backend || r.backend.startsWith("memorable") ? "Memorable" : r.backend}</b> memory
                </p>`
            : r
              ? html`<p class="pb-match none">No learned path yet</p>
                  <p class="pb-meta">
                    ${r.closest ? html`closest: ${r.closest.length > 60 ? `${r.closest.slice(0, 60)}…` : r.closest}${r.similarity != null ? ` (${r.similarity.toFixed(2)})` : ""} · ` : nothing}searched
                    Memorable memory
                  </p>`
              : html`<p class="pb-meta">${running ? "Looking up memory…" : "No memory lookup in this ticket."}</p>`
      }
      ${
        saved
          ? html`<p class="pb-saved">
              New path saved to Memorable${saved.title ? html`: <b>${saved.title}</b>` : nothing}
              ${saved.id ? html`<code class="pb-id">${saved.id}</code>` : nothing}
            </p>`
          : nothing
      }
    </div>

    ${
      r?.found && !r.compiled
        ? html`<div class="pb-block">
            <h4>The learned path${uses != null ? ` · used ${uses}× before` : ""}</h4>
            ${
              r.earlierTickets?.length
                ? html`<ul class="pb-earlier">
                    ${r.earlierTickets
                      .slice(0, 5)
                      .map(
                        (e) =>
                          html`<li><code>${e.id}</code><span>${e.text.split(" ").slice(0, 9).join(" ")}…</span></li>`,
                      )}
                  </ul>`
                : nothing
            }
          </div>`
        : nothing
    }
    ${
      pathTools.length
        ? comparison(pathTools, calls)
        : html`<div class="pb-block">
            <h4>This ticket's tool calls</h4>
            <ol class="pb-list">
              ${calls.map(
                (c) =>
                  html`<li class=${c.error ? "err" : ""}>
                    <code>${c.name}</code>${hostTag(hostOf(c.name))}<span class="pb-ms"
                      >${c.ms == null ? "…" : fmtMs(c.ms)}</span
                    >
                  </li>`,
              )}
            </ol>
          </div>`
    }
    ${
      plan
        ? html`<details class="pb-plan">
            <summary>
              Compiled program
              <code>${plan.id}</code>
              ${plan.enabled === false ? html`<span class="pb-dim">(not yet promoted)</span>` : nothing}
            </summary>
            <pre>${JSON.stringify(r?.compiled ? plan : { ...plan, reply: undefined }, null, 2)}</pre>
          </details>`
        : nothing
    }
  </section>`;
}

const EXPECTED = 400;
const BUCKET = 25;

function rowTier(r: ReplayRow): Tier | "error" {
  if (r.tier === "error" || r.error) return "error";
  if (r.tier === "compiled" || r.tier === "recalled" || r.tier === "explored") return r.tier;
  return r.recalled ? "recalled" : "explored";
}

interface Bucket {
  from: number;
  to: number;
  n: number;
  share: Record<Tier, number>;
  cost: number;
  complete: boolean;
}

function buckets(rows: ReplayRow[]): Bucket[] {
  const out: Bucket[] = [];
  for (let s = 0; s < rows.length; s += BUCKET) {
    const slice = rows.slice(s, s + BUCKET);
    const ok = slice.filter((r) => rowTier(r) !== "error");
    const count = (t: Tier): number => ok.filter((r) => rowTier(r) === t).length / Math.max(ok.length, 1);
    out.push({
      from: s + 1,
      to: s + BUCKET,
      n: ok.length,
      share: { explored: count("explored"), recalled: count("recalled"), compiled: count("compiled") },
      cost: ok.reduce((a, r) => a + (r.cost ?? 0) + (r.normCost ?? 0), 0) / Math.max(ok.length, 1),
      complete: slice.length === BUCKET && ok.length >= BUCKET * 0.8,
    });
  }
  return out;
}

function curveChart(bs: Bucket[]): TemplateResult {
  const W = 560;
  const H = 250;
  const pad = { l: 50, r: 16, t: 16, b: 40 };
  const slots = EXPECTED / BUCKET;
  const bw = (W - pad.l - pad.r) / slots;
  const ih = H - pad.t - pad.b;
  const maxCost = Math.max(0.05, ...bs.filter((b) => b.n).map((b) => b.cost)) * 1.1;
  const yc = (v: number): number => pad.t + (1 - v / maxCost) * ih;
  const pts = bs.map((b, i) => (b.n ? `${pad.l + bw * (i + 0.5)},${yc(b.cost).toFixed(1)}` : "")).filter(Boolean);
  return html`<svg
    class="pb-chart"
    viewBox="0 0 ${W} ${H}"
    role="img"
    aria-label="Share of tickets per tier and cost per ticket"
  >
    ${[0, 0.5, 1].map(
      (f) => svg`<line class="grid" x1=${pad.l} x2=${W - pad.r} y1=${yc(f * maxCost)} y2=${yc(f * maxCost)}></line>
        <text class="axis" x=${pad.l - 8} y=${yc(f * maxCost) + 5} text-anchor="end">$${(f * maxCost).toFixed(2)}</text>`,
    )}
    ${bs.map((b, i) => {
      if (!b.n) return svg``;
      const x = pad.l + bw * i + 2;
      let y = pad.t + ih;
      return (["explored", "recalled", "compiled"] as Tier[]).map((t) => {
        const h = b.share[t] * ih;
        y -= h;
        return svg`<rect class="bar ${t} ${b.complete ? "" : "partial"}" x=${x} y=${y} width=${bw - 4} height=${h}></rect>`;
      });
    })}
    ${pts.length > 1 ? svg`<polyline class="line-cost" points=${pts.join(" ")}></polyline>` : nothing}
    ${pts.map((p) => {
      const [x, y] = p.split(",");
      return svg`<circle class="pt-cost" cx=${x} cy=${y} r="4"></circle>`;
    })}
    <text class="axis" x=${pad.l} y=${H - 12}>ticket 1</text>
    <text class="axis" x=${W / 2} y=${H - 12} text-anchor="middle">${EXPECTED / 2}</text>
    <text class="axis" x=${W - pad.r} y=${H - 12} text-anchor="end">${EXPECTED}</text>
  </svg>`;
}

function curveSection(): TemplateResult {
  const rows = state.replay;
  if (!rows.length)
    return html`<section class="pb-card">
      <h3>Learning curve</h3>
      <p class="pb-empty">Waiting for the replay run…</p>
    </section>`;
  const n = rows.length;
  const errors = rows.filter((r) => rowTier(r) === "error").length;
  const bs = buckets(rows);
  const done = bs.filter((b) => b.complete);
  const inProgress = n < EXPECTED;
  const first = done[0];
  const last = done.length > 1 ? done.at(-1) : undefined;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return html`<section class="pb-card ${inProgress ? "pb-progress" : ""}">
    <h3>
      Learning curve
      ${state.replaySource && state.replaySource !== "results.jsonl" ? html`<span class="pb-dim">${state.replaySource === "label-run" ? "finished earlier run" : "sample data"}</span>` : nothing}
    </h3>
    ${
      inProgress
        ? html`<p class="pb-status">
            Run in progress · ${n} of ${EXPECTED} tickets${errors ? ` · ${errors} failed (retrying)` : ""}
          </p>`
        : errors
          ? html`<p class="pb-status">${errors} of ${n} tickets failed and are left out</p>`
          : nothing
    }
    ${
      first && last && !inProgress
        ? html`<p class="pb-headline">
            Tickets ${first.from}–${first.to}: <b>${fmtUsd(first.cost)}</b>/ticket · Tickets ${last.from}–${last.to}:
            <b>${fmtUsd(last.cost)}</b>/ticket, ${pct(last.share.compiled)} compiled, ${pct(last.share.recalled)}
            recalled
          </p>`
        : first
          ? html`<p class="pb-headline dim">
              So far: tickets ${first.from}–${first.to} <b>${fmtUsd(first.cost)}</b>/ticket${
                last
                  ? html` → tickets ${last.from}–${last.to} <b>${fmtUsd(last.cost)}</b>/ticket,
                      ${pct(last.share.recalled + last.share.compiled)} reused`
                  : nothing
              }
            </p>`
          : nothing
    }
    ${curveChart(bs)}
    <div class="pb-legend2">
      <span><i class="sw explored"></i>explored</span>
      <span><i class="sw recalled"></i>recalled path</span>
      <span><i class="sw compiled"></i>compiled</span>
      <span><i class="sw cost"></i>cost per ticket</span>
    </div>
    <p class="pb-foot">Each bar is 25 tickets; its colors show how those tickets were handled.</p>
  </section>`;
}

// ---- Route map: Customer → River → three lanes, highlighting the lane this ticket took ----
const MAP_W = 560;
const MAP_H = 284;
const LANE_X = 222;
const LANE_W = 306;
const LANE_H = 84;
const LANE_GAP = 12;
// Each node line is [text, host?]; host words are tinted so every sponsor is visible where it acts.
type NodeLine = [string, Host?];
const LANES: { tier: Tier; label: string; nodes: NodeLine[][] }[] = [
  {
    tier: "compiled",
    label: "COMPILED",
    nodes: [[["QM", "QM"], ["JSON plan"]], [["Shopify", "Shopify"], ["tools"]], [["Reply"]]],
  },
  {
    tier: "recalled",
    label: "RECALLED",
    nodes: [[["Memorable", "Memorable"], ["path"]], [["QM", "QM"], ["agent"]], [["Reply"]]],
  },
  {
    tier: "explored",
    label: "EXPLORED",
    nodes: [
      [["QM", "QM"], ["agent"]],
      [
        ["GBrain", "GBrain"],
        ["+ Shopify", "Shopify"],
      ],
      [["Memorable", "Memorable"], ["saves"]],
    ],
  },
];
const laneY = (i: number): number => 4 + i * (LANE_H + LANE_GAP);
const NODE_W = 86;
const NODE_GAP = (LANE_W - 16 - NODE_W * 3) / 2;
const nodeX = (j: number): number => LANE_X + 8 + j * (NODE_W + NODE_GAP);
const NODE_Y = 24;
const NODE_H = 34;
const RIVER = { x: 84, y: 42, w: 122, h: 200 };
const CUST = { x: 2, y: 114, w: 66, h: 56 };
const MID = RIVER.y + RIVER.h / 2;

function riverLabel(r: Recall | null): string {
  const fromRow = state.replay.find((row) => (row as { normalizer?: string }).normalizer?.startsWith("river"));
  const n = r?.normalizer?.startsWith("river")
    ? r.normalizer
    : (fromRow as { normalizer?: string } | undefined)?.normalizer;
  const ver = n?.split(":")[1] ?? "r1@50";
  return `River ${ver}`;
}

function laneShare(tier: Tier): TemplateResult {
  const rows = state.replay;
  if (!rows.length) return svg`<tspan class="rm-dim">no replay run yet</tspan>`;
  const ok = rows.filter((row) => rowTier(row) !== "error");
  const share = ok.filter((row) => rowTier(row) === tier).length / Math.max(ok.length, 1);
  const inProgress = rows.length < EXPECTED;
  return inProgress
    ? svg`<tspan class="rm-dim">${Math.round(share * 100)}% of ${ok.length} · run in progress</tspan>`
    : svg`<tspan class="rm-share-b">${Math.round(share * 100)}%</tspan> of ${ok.length} tickets`;
}

function routeMap(): TemplateResult {
  const tt = state.turns.length ? ticketTurns(state.turns) : [];
  const calls = tt.flatMap((t) => t.tools);
  const r = recallOf(tt);
  const compiled = !!r?.planId || (tt.length > 0 && tt.every((t) => t.tools.length > 0 && t.costUsd === 0));
  const tier: Tier | "none" = !calls.length ? "none" : compiled ? "compiled" : r?.found ? "recalled" : "explored";
  const running = tt.at(-1)?.running ?? false;
  const elapsed = tt.reduce((s, t) => s + ((t.running ? Date.now() : t.endedAt) - t.startedAt), 0);
  const cost = tt.some((t) => t.costUsd != null) ? tt.reduce((s, t) => s + (t.costUsd ?? 0), 0) : null;
  const mc = tt.some((t) => t.modelCalls != null) ? tt.reduce((s, t) => s + (t.modelCalls ?? 0), 0) : null;
  const nums =
    tier === "compiled"
      ? `${fmtMs(r?.ms ?? elapsed)} · $0.00 · 0 model calls`
      : `${fmtMs(elapsed)} · ${cost == null ? "—" : fmtUsd(cost)} · ${mc == null ? "—" : mc} model call${mc === 1 ? "" : "s"}`;
  const ti = LANES.findIndex((l) => l.tier === tier);
  const ny = (i: number): number => laneY(i) + NODE_Y + NODE_H / 2;
  const fork = (i: number): string =>
    `M${RIVER.x + RIVER.w},${MID} C${RIVER.x + RIVER.w + 12},${MID} ${LANE_X - 10},${ny(i)} ${LANE_X + 8},${ny(i)}`;
  const route =
    ti >= 0
      ? `M${CUST.x + CUST.w / 2},${MID} L${RIVER.x + RIVER.w},${MID} ` +
        fork(ti).slice(fork(ti).indexOf("C")) +
        ` L${nodeX(2) + NODE_W - 6},${ny(ti)}`
      : "";
  const std = r?.normalized ?? (tt.length ? "…" : "waiting for a ticket");
  return html`<details class="pb-card rm" open>
    <summary>
      Route map
      ${tier !== "none" ? html`<span class="rm-sum ${tier}">${tier}${running ? " · live" : ""}</span>` : nothing}
    </summary>
    <svg
      class="rm-svg ${tier === "none" ? "idle" : "has-tier"}"
      viewBox="0 0 ${MAP_W} ${MAP_H}"
      role="img"
      aria-label="Route map"
    >
      <defs>
        <marker id="rm-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" class="rm-ah"></path>
        </marker>
        ${LANES.map(
          (
            l,
          ) => svg`<marker id="rm-a-${l.tier}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" class="rm-ah ${l.tier}"></path></marker>`,
        )}
      </defs>
      <rect class="rm-box" x=${CUST.x} y=${CUST.y} width=${CUST.w} height=${CUST.h} rx="8"></rect>
      <text class="rm-node-t" x=${CUST.x + CUST.w / 2} y=${MID - 3} text-anchor="middle">Customer</text>
      <text class="rm-node-t" x=${CUST.x + CUST.w / 2} y=${MID + 11} text-anchor="middle">message</text>
      <line class="rm-link" x1=${CUST.x + CUST.w} y1=${MID} x2=${RIVER.x - 2} y2=${MID} marker-end="url(#rm-a)"></line>
      <rect class="rm-river" x=${RIVER.x} y=${RIVER.y} width=${RIVER.w} height=${RIVER.h} rx="10"></rect>
      <text class="rm-river-t" x=${RIVER.x + RIVER.w / 2} y=${RIVER.y + 20} text-anchor="middle">River</text>
      <text class="rm-river-s" x=${RIVER.x + RIVER.w / 2} y=${RIVER.y + 34} text-anchor="middle">${riverLabel(r)}</text>
      <text class="rm-river-k" x=${RIVER.x + 8} y=${RIVER.y + 54}>STANDARDIZED</text>
      <foreignObject x=${RIVER.x + 6} y=${RIVER.y + 60} width=${RIVER.w - 12} height=${RIVER.h - 66}>
        <div xmlns="http://www.w3.org/1999/xhtml" class="rm-std">${std}</div>
      </foreignObject>
      ${LANES.map(
        (l, i) =>
          svg`<path class="rm-fork ${l.tier} ${ti >= 0 && ti !== i ? "dim" : ""}" d=${fork(i)} marker-end="url(#rm-a-${l.tier})"></path>`,
      )}
      ${LANES.map((l, i) => {
        const y = laneY(i);
        const on = ti === i;
        return svg`<g class="rm-lane ${l.tier} ${ti >= 0 && !on ? "dim" : ""} ${on ? "on" : ""}">
          <rect class="rm-lane-bg" x=${LANE_X} y=${y} width=${LANE_W} height=${LANE_H} rx="10"></rect>
          <text class="rm-lane-t" x=${LANE_X + 10} y=${y + 15}>${l.label}</text>
          <text class="rm-share" x=${LANE_X + LANE_W - 10} y=${y + 15} text-anchor="end">${laneShare(l.tier)}</text>
          ${l.nodes.map((lines, j) => {
            const x = nodeX(j);
            const cy = y + NODE_Y + NODE_H / 2;
            return svg`<rect class="rm-node" x=${x} y=${y + NODE_Y} width=${NODE_W} height=${NODE_H} rx="6"></rect>
              ${lines.map(
                (t, k) =>
                  svg`<text class="rm-node-t ${t[1] ? `h-${t[1].toLowerCase()}` : ""}" x=${x + NODE_W / 2} y=${cy + 4 + (k - (lines.length - 1) / 2) * 12} text-anchor="middle">${t[0]}</text>`,
              )}
              ${j < 2 ? svg`<line class="rm-link ${l.tier}" x1=${x + NODE_W} y1=${cy} x2=${x + NODE_W + NODE_GAP - 1} y2=${cy} marker-end="url(#rm-a-${l.tier})"></line>` : nothing}`;
          })}
          ${on ? svg`<text class="rm-nums" x=${LANE_X + 10} y=${y + LANE_H - 8}>${nums}</text>` : nothing}
        </g>`;
      })}
      <path
        class="rm-learn"
        d="M${LANE_X + LANE_W},${ny(2)} C${MAP_W - 4},${ny(2)} ${MAP_W - 4},${ny(1)} ${LANE_X + LANE_W + 2},${ny(1)}"
        marker-end="url(#rm-a)"
      ></path>
      <path
        class="rm-learn"
        d="M${LANE_X + LANE_W},${ny(1)} C${MAP_W - 4},${ny(1)} ${MAP_W - 4},${ny(0)} ${LANE_X + LANE_W + 2},${ny(0)}"
        marker-end="url(#rm-a)"
      ></path>
      <text class="rm-learn-t" transform="translate(${MAP_W - 3},${MAP_H / 2}) rotate(-90)" text-anchor="middle">
        learned
      </text>
      ${route ? svg`<circle class="rm-dot ${tier}" r="4.5"><animateMotion dur="2.6s" repeatCount="indefinite" path=${route}></animateMotion></circle>` : nothing}
    </svg>
  </details>`;
}

function panelTpl(onClose?: () => void): TemplateResult {
  return html`<div class="paths-panel pb">
    <header class="paths-head">
      ${icon(Route, 22)}
      <h2>Paths</h2>
      <span class="paths-session" title=${state.sessionId ?? ""}
        >${state.sessionTitle || (state.sessionId ? "current ticket" : "no ticket")}</span
      >
      ${onClose ? html`<button class="paths-close" type="button" aria-label="Close Paths" @click=${onClose}>×</button>` : nothing}
    </header>
    ${routeMap()} ${ticketSection()} ${curveSection()}
    ${state.error ? html`<p class="paths-error">${state.error}</p>` : nothing}
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
