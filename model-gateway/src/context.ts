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

export interface SurfaceCost {
  surface: string;
  tokens: number;
  /** Fraction of the always-on total, 0..1 — a share, not a percentage, so the renderer decides. */
  share: number;
}

export interface CostBreakdown {
  /** Exactly what ContextReport.alwaysOnTokens sums, so the two cannot report different totals. */
  totalTokens: number;
  /** Most expensive first — the head of this list is the surface report() already calls `largest`. */
  surfaces: SurfaceCost[];
}

/** Conservative, portable, stable. Never an underestimate in practice for English + code. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/**
 * The surfaces a session pays for whether or not it uses them. One definition, used here and by
 * report(), because a second one would drift — and the smaller of two answers to "unavoidable" is
 * the one that gets quoted.
 */
function alwaysOn(lines: ContextLine[]): ContextLine[] {
  return lines.filter((l) => l.always);
}

export function line(surface: string, text: string, always: boolean, detail?: string): ContextLine {
  return { surface, bytes: Buffer.byteLength(text, "utf8"), tokens: estimateTokens(text), always, detail };
}

export function report(lines: ContextLine[], budgetTokens: number): ContextReport {
  const always = alwaysOn(lines);
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

/**
 * Where the standing cost actually goes, as data.
 *
 * report() answers "are we over budget"; deciding what to cut needs the split and the order, so it
 * is a separate call rather than a second rendering. Nothing here re-invents a number: the tokens
 * are the ones estimateTokens put on the lines, and the always-on set is the same filter report()
 * holds to the budget — a breakdown that estimated differently would argue with the report instead
 * of with the code.
 */
export function costBreakdown(lines: ContextLine[]): CostBreakdown {
  const standing = alwaysOn(lines);
  const totalTokens = standing.reduce((n, l) => n + l.tokens, 0);

  // By surface, not by line. Two always-on lines can carry the same surface name — standing
  // rules read from two files are still "standing rules" to whoever reads the report — and
  // listing that name twice with a partial share each would understate whichever entry the
  // reader looked at. Aggregating is what makes the name in the report mean what it says.
  const bySurface = new Map<string, number>();
  for (const l of standing) bySurface.set(l.surface, (bySurface.get(l.surface) ?? 0) + l.tokens);

  return {
    totalTokens,
    // An empty (or free) breakdown has no denominator: a share is 0, never NaN, because a caller
    // summing shares to sanity-check the report should not inherit an arithmetic error.
    surfaces: [...bySurface]
      .map(([surface, tokens]) => ({ surface, tokens, share: totalTokens === 0 ? 0 : tokens / totalTokens }))
      .sort((a, b) => b.tokens - a.tokens),
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
