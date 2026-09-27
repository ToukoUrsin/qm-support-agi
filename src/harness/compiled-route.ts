// Hackathon: compiled-path route. With COMPILED_ROUTES=1, a user message is first offered to the Northwind MCP's
// /try_compiled endpoint (deterministic plan, no model call). If a promoted plan serves it, the turn is recorded as a
// synthetic recall_path hit + the plan's tool steps (payload.compiled=true) + the reply, and the model never runs.
// Any error, timeout or {served:false} returns null and the normal harness turn proceeds.
import type { HarnessTurnInput, HarnessTurnResult } from "./harness.ts";

const URL_ = process.env.COMPILED_ROUTES_URL ?? "http://127.0.0.1:8790/try_compiled";
const SERVER = process.env.COMPILED_ROUTES_MCP ?? "northwind";

type Served = {
  served: true;
  reply: string;
  planId: string;
  risk?: string;
  ms: number;
  normalizer?: string;
  steps: { tool: string; input: unknown; output: unknown }[];
  plan?: { match?: { topic?: string } };
};

export async function tryCompiledTurn(turn: HarnessTurnInput): Promise<HarnessTurnResult | null> {
  if (process.env.COMPILED_ROUTES !== "1") return null;
  const text = turn.input?.trim();
  if (!text || !/@/.test(text) || turn.attachments?.length) return null;
  let r: Served | { served: false };
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(Number(process.env.COMPILED_ROUTES_TIMEOUT_MS ?? 12000)),
    });
    if (!res.ok) return null;
    r = (await res.json()) as Served | { served: false };
  } catch {
    return null;
  }
  if (!r.served) return null;
  const scopeLabel = turn.scopeLabel;
  await turn.emit({
    type: "user",
    payload: {
      text: turn.input,
      ...(turn.environment ? { environment: turn.environment } : {}),
      ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
    },
    scopeLabel,
  });
  const base = `compiled-${Date.now().toString(36)}`;
  const tools = r.steps.map((s) => s.tool);
  const recall = {
    found: true,
    compiled: true,
    planId: r.planId,
    id: r.planId,
    title: r.plan?.match?.topic ?? r.planId,
    risk: r.risk,
    tools,
    steps: tools,
    ms: r.ms,
    modelCalls: 0,
    normalizer: r.normalizer,
    backend: "compiled plan",
  };
  const call = async (i: number, tool: string, args: unknown, result: unknown) => {
    const callId = `${base}-${i}`;
    await turn.emit({
      type: "tool_call",
      payload: { tool: `${SERVER}_${tool}`, mcpServer: SERVER, args, callId, compiled: true },
      scopeLabel,
    });
    await turn.emit({
      type: "tool_result",
      payload: {
        tool: `${SERVER}_${tool}`,
        mcpServer: SERVER,
        callId,
        isError: false,
        compiled: true,
        result: typeof result === "string" ? result : JSON.stringify(result),
      },
      scopeLabel,
    });
  };
  await call(0, "recall_path", { request: text }, recall);
  for (const [i, s] of r.steps.entries()) await call(i + 1, s.tool, s.input, s.output);
  await turn.emit({ type: "assistant", payload: { text: r.reply, compiled: true, planId: r.planId }, scopeLabel });
  return { reply: r.reply, modelCalls: 0 };
}
