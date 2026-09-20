/**
 * What break-free costs a session before any work happens.
 *
 * Every registered tool's schema reaches the lead's context whether or not it is ever called,
 * and is re-sent every turn. So do the server instructions and whatever the ledger injects.
 * None of it was measured, so none of it could be argued about — and an unmeasured cost only
 * ever grows.
 *
 * The estimator is deliberately crude: ceil(UTF-8 bytes / 3), the same approximation firstmate
 * uses for its startup-memory budget. It is not a tokenizer and does not try to be. A budget
 * needs to be stable across providers and to never flatter itself; an exact count would drift
 * with every model version and invite argument instead of action.
 */
export interface ContextLine {
  surface: string;
  bytes: number;
  tokens: number;
  /** Paid every session regardless of use, versus only when something pulls it in. */
  always: boolean;
  detail?: string;
}

export interface ContextReport {
  budgetTokens: number;
  alwaysOnTokens: number;
  totalTokens: number;
  overBudget: boolean;
  /** The single largest always-on contributor, which is where an argument should start. */
  largest?: ContextLine;
  lines: ContextLine[];
}

/** Conservative, portable, stable. Never an underestimate in practice for English + code. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function line(surface: string, text: string, always: boolean, detail?: string): ContextLine {
  return { surface, bytes: Buffer.byteLength(text, "utf8"), tokens: estimateTokens(text), always, detail };
}

export function report(lines: ContextLine[], budgetTokens: number): ContextReport {
  const always = lines.filter((l) => l.always);
  const alwaysOnTokens = always.reduce((n, l) => n + l.tokens, 0);
  return {
    budgetTokens,
    alwaysOnTokens,
    totalTokens: lines.reduce((n, l) => n + l.tokens, 0),
    // Only the always-on surface is held to the budget. Something pulled in deliberately for one
    // task is a choice the caller made; something charged to every session is not.
    overBudget: alwaysOnTokens > budgetTokens,
    largest: always.slice().sort((a, b) => b.tokens - a.tokens)[0],
    lines: lines.slice().sort((a, b) => b.tokens - a.tokens),
  };
}

/** One line per surface, widest first, with the budget verdict last. */
export function renderReport(r: ContextReport): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  const rows = r.lines.map((l) => `  ${pad(l.surface, 26)} ${String(l.tokens).padStart(7)} tok  ${l.always ? "every session" : "on demand   "}${l.detail ? `  ${l.detail}` : ""}`);
  const verdict = r.overBudget
    ? `OVER by ${r.alwaysOnTokens - r.budgetTokens} tok — largest: ${r.largest?.surface ?? "?"} (${r.largest?.tokens ?? 0})`
    : `within budget (${r.budgetTokens - r.alwaysOnTokens} tok to spare)`;
  return [
    `context: ${r.alwaysOnTokens} tok every session, budget ${r.budgetTokens}`,
    ...rows,
    `  ${verdict}`,
  ].join("\n");
}
