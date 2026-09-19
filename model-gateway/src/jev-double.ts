/**
 * A deterministic TypeSafe System One double.
 *
 * Two callers, one implementation:
 *   - the test suite, so routing tests are offline and byte-identical on every run;
 *   - `bf bench route` / `bf demo` in their offline modes, which replay a recorded decision set
 *     through the REAL client and the real routing code — the double only replaces the network.
 *
 * It answers exactly what it was told to answer, keyed by the task id inside each question id
 * (`<taskId>__lane`). No clock, no randomness: the same request produces the same bytes.
 */
import http from "node:http";
import { once } from "node:events";

export interface DoubleDecision {
  lane: string;
  confidence: number;
  difficulty: number;
  /** Probability that the task is sensitive (Noul) */
  sensitive: number;
  /** Probability that it needs repo context (Noul) */
  context: number;
  /** Tripwire flags (Nouls, 0..1). */
  test_weakened?: number;
  security_touch?: number;
  destructive_data?: number;
  scope_creep?: number;
  /** Tripwire risk on the 0..4 scale (Score), and the confidence returned with it. */
  risk?: number;
  risk_confidence?: number;
  probs?: Record<string, number> | null;
}

export interface TypeSafeDouble {
  port: number;
  /** baseUrl to put in `providers.typesafe.baseUrl` */
  url: string;
  /** Every question set received, in order */
  requests: { model: string; state: unknown; questions: Record<string, unknown> }[];
  calls: { model: string; questions: string[] }[];
  setDecisions(next: Record<string, DoubleDecision>): void;
  setMode(mode: "ok" | "server_error" | "unauthorized" | "malformed"): void;
  queueFailures(n: number): void;
  close(): Promise<void>;
}

const DEFAULT_DECISION: DoubleDecision = { lane: "fast", confidence: 0.9, difficulty: 2, sensitive: 0, context: 0, };
/** The five options the lane Choice actually offers — the double must spread mass over the same set. */
const LANE_KEYS = ["local", "fast", "strong", "thinker", "unclear"];

/** A 5-level distribution peaked at `level`; the rest of the mass spread evenly. */
function scoreDistribution(level: number): Record<string, number> {
  const rest = 0.2 / 4;
  return Object.fromEntries(["0", "1", "2", "3", "4"].map((l) => [l, Number(l) === level ? 0.8 : rest]));
}

function laneDistribution(d: DoubleDecision): Record<string, number> {
  if (d.probs) return d.probs;
  const rest = Number(((1 - d.confidence) / (LANE_KEYS.length - 1)).toFixed(6));
  return Object.fromEntries(LANE_KEYS.map((l) => [l, l === d.lane ? d.confidence : rest]));
}

export async function startTypeSafeDouble(opts: { decisions?: Record<string, DoubleDecision>; failures?: number; mode?: "ok" | "server_error" | "unauthorized" | "malformed"; model?: string } = {}): Promise<TypeSafeDouble> {
  const decisions = new Map<string, DoubleDecision>(Object.entries(opts.decisions ?? {}));
  const requests: TypeSafeDouble["requests"] = [];
  const calls: TypeSafeDouble["calls"] = [];
  let failures = opts.failures ?? 0;
  let mode = opts.mode ?? "ok";
  const model = opts.model ?? "jev-1.13.0";

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        return json(200, { models: [{ name: "jev-latest", description: "flagship", release_date: "2026-09-16" }, { name: model, description: "pinned", release_date: "2026-09-16" }] });
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/systemone")) return json(404, { error: "not found" });
      let body: { model: string; state: unknown; questions: Record<string, { type: string }> };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return json(422, { error: "invalid json" });
      }
      requests.push(body);
      calls.push({ model: body.model, questions: Object.keys(body.questions ?? {}) });
      if (failures > 0) {
        failures--;
        // retry-after: 0 keeps backoff instant so retry tests never sleep
        return json(429, { error: "rate limited" }, { "retry-after": "0" });
      }
      if (mode === "server_error") return json(529, { error: "overloaded" });
      if (mode === "unauthorized") return json(401, { error: "bad key" });
      if (mode === "malformed") return json(200, { model, answers: "not an object" });

      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(body.questions ?? {})) {
        const sep = key.lastIndexOf("__");
        const taskId = key.slice(0, sep);
        const kind = key.slice(sep + 2);
        const d = { ...DEFAULT_DECISION, ...(decisions.get(taskId) ?? {}) };
        if (kind === "lane") answers[key] = { type: "choice", choice: d.lane, probabilities: laneDistribution(d), confidence: d.confidence };
        else if (kind === "difficulty") answers[key] = { type: "score", score: d.difficulty, legend: { "0": "trivial", "1": "mechanical", "2": "ordinary", "3": "multi-file", "4": "cross-cutting" }, probabilities: scoreDistribution(d.difficulty), confidence: 0.8 };
        else if (kind === "sensitive") answers[key] = { type: "noul", noul: d.sensitive };
        else if (kind === "needs_repo_context") answers[key] = { type: "noul", noul: d.context };
        else if (kind === "test_weakened") answers[key] = { type: "noul", noul: d.test_weakened ?? 0 };
        else if (kind === "security_touch") answers[key] = { type: "noul", noul: d.security_touch ?? 0 };
        else if (kind === "destructive_data") answers[key] = { type: "noul", noul: d.destructive_data ?? 0 };
        else if (kind === "scope_creep") answers[key] = { type: "noul", noul: d.scope_creep ?? 0 };
        else if (kind === "risk") answers[key] = { type: "score", score: d.risk ?? 0, legend: { "0": "cosmetic", "1": "local", "2": "wider blast radius", "3": "risky", "4": "incident" }, probabilities: scoreDistribution(Math.max(0, Math.min(4, Math.round(d.risk ?? 0)))), confidence: d.risk_confidence ?? 0.8 };
      }
      // Deterministic usage derived from the request itself, so cost assertions are stable.
      json(200, { model, answers, usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 } });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    calls,
    setDecisions: (next: Record<string, DoubleDecision>) => {
      for (const [k, v] of Object.entries(next)) decisions.set(k, v);
    },
    setMode: (next: "ok" | "server_error" | "unauthorized" | "malformed") => {
      mode = next;
    },
    queueFailures: (n: number) => {
      failures = n;
    },
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
