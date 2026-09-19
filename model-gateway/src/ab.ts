/**
 * `bf ab` — one plan, run twice on one commit, compared from the scorecard lines.
 *
 * Issue #22's criteria 2, 3 and 8 have never been measured on a real run: `bf validate` compares
 * the lane a LABEL names against the lane a lead would pick, so "does routing still pass verify as
 * often as sending everything to strong" has never been answered by running both. This module is
 * the arithmetic half of the thing that answers it — the two pass rates, the calibration bands, the
 * per-arm spend and PASS/MISS per criterion. The runner half (`bf ab` in cli.ts) runs the plan twice
 * and hands the rows here, which is what makes the maths testable offline.
 *
 * PASS/FAIL COMES FROM THE SCORECARD `verify_ok` FIELD, which is the gateway's own verify exit
 * code. Nothing here reads a worker's report text: a model saying it finished is not evidence, and a
 * harness that trusted prose would only ever be able to report success.
 *
 * A row whose `verify_ok` is null (no verify command on the task, or the run errored or was
 * cancelled) is EXCLUDED and counted, never scored as a pass, and a plan task with no verify command
 * is named rather than silently dropped. A criterion that missed its target prints as MISS; one with
 * no runs to compute from prints as NOT MEASURED with the reason. An empty arm is reported as empty
 * instead of dividing by zero and printing a rate.
 */
import type { ScorecardRecord } from "./ledger.js";

/** Criterion 2's tolerance: the routed arm must be within this many points of all-strong. */
export const AB_TOLERANCE_PTS = 5;

export type AbArmName = "routed" | "strong";

/** A plan task as read from the plan file. A missing `verify` excludes it from criteria 2 and 3. */
export interface AbPlanTask {
  id: string;
  verify?: string;
}

/**
 * One scorecard row, joined to the ledger task that wrote it.
 *
 * `verify_ok` is the scorecard's own field. `plan_task`, `confidence` and `model` come from the
 * ledger task (`plan_task`, `route_confidence`), because a scorecard line carries the ledger id
 * rather than the plan's own task id, and carries no confidence at all.
 */
export interface AbRow {
  /** Ledger task id — `ScorecardRecord.task`. */
  task: string;
  /** The plan's own task id, from the ledger task. null when the join found nothing. */
  plan_task: string | null;
  lane: string;
  /** The gateway's own verify result. null = the scorecard recorded no verify result. */
  verify_ok: boolean | null;
  attempts: number;
  cost_usd: number;
  /** `route_confidence` of the decision that chose the lane; null when the task was not routed. */
  confidence: number | null;
  model: string;
}

export interface AbArmInput {
  name: AbArmName;
  label: string;
  /** The first pass: one row per task the arm ran. */
  rows: AbRow[];
  /** The second pass: rows for the first-pass tasks whose verify failed and were retried once. */
  retry_rows?: AbRow[];
}

export type AbVerdict = "PASS" | "MISS" | "NOT MEASURED";

/** One confidence band of first-pass routed runs, with what verify said about them. */
export interface AbBucket {
  bucket: "<0.5" | "0.5-0.8" | ">=0.8";
  runs: number;
  failed: number;
  /** `null`, not 0, when nothing ran here: an empty band measures nothing. */
  fail_pct: number | null;
}

export interface AbArmMetrics {
  name: AbArmName;
  label: string;
  /** Every scorecard row handed in for this arm, before exclusion (for the task table and for JSON). */
  rows: AbRow[];
  /** Rows scored: they had a verify result AND a plan task that declares one. Both denominators. */
  runs: number;
  first_pass_passed: number;
  /** `null` when nothing was scored — never 0, which would read as "everything failed". */
  first_pass_pct: number | null;
  /** First-pass failures that were run a second time, and how many of those passed. */
  retried: number;
  retry_passed: number;
  /** First-pass failures with no usable retry row (not retried, or the retry produced no result). */
  retry_missing: number;
  after_retry_passed: number;
  after_retry_pct: number | null;
  /** Rows excluded because the scorecard carried no verify result. Counted, never a pass. */
  excluded_unverified: number;
  /** Rows for a plan task whose `verify` is absent — a row that cannot score criteria 2 or 3. */
  excluded_no_verify: number;
  /** Rows that could not be joined to a plan task of THIS plan: another plan's work, or untracked. */
  excluded_unmatched: number;
  /** Plan tasks with a verify command and no scorecard row at all for this arm (escalated, or never run). */
  missing: string[];
  /** Sum of the scorecard `cost_usd` for this arm's rows and the retries it booked. */
  cost_usd: number;
  models: string[];
  /** The confidence bands, always all three, so an empty one is visible. */
  buckets: AbBucket[];
}

export interface AbCriterion {
  routed_pct: number | null;
  strong_pct: number | null;
  /** `routed - strong` in percentage points; null when an arm scored nothing. */
  gap_pts: number | null;
  target: string;
  verdict: AbVerdict;
  note: string | null;
}

export interface AbReport {
  plan_tasks: number;
  /** Plan tasks that have a verify command and can therefore be scored at all. */
  scored_tasks: number;
  /** Plan tasks with no `verify`: excluded from criteria 2 and 3, and named here. */
  excluded_no_verify: string[];
  arms: Record<AbArmName, AbArmMetrics>;
  criteria: {
    /** Criterion 2: first-pass verify rate per arm, before any retry. */
    first_pass: AbCriterion;
    /** Criterion 3: the same rows after ONE retry of the failures. */
    after_retry: AbCriterion;
    /** Criterion 8: the routed arm's own confidence against a real verify outcome. */
    calibration: {
      high: AbBucket;
      mid: AbBucket;
      low: AbBucket;
      holds: boolean | null;
      verdict: AbVerdict;
      note: string | null;
    };
  };
  /** Criteria that came out MISS. A non-empty list is a failed run, not a rounding detail. */
  missed: string[];
  /** Criteria with nothing to compute from, with the reason in the printed report. */
  unmeasured: string[];
  verdict: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (passed: number, runs: number): number | null => (runs ? Math.round((passed / runs) * 100) : null);

function emptyBuckets(): AbBucket[] {
  return [
    { bucket: "<0.5", runs: 0, failed: 0, fail_pct: null },
    { bucket: "0.5-0.8", runs: 0, failed: 0, fail_pct: null },
    { bucket: ">=0.8", runs: 0, failed: 0, fail_pct: null },
  ];
}

const bucketFor = (buckets: AbBucket[], confidence: number): AbBucket => buckets[confidence < 0.5 ? 0 : confidence < 0.8 ? 1 : 2];

/**
 * One arm's numbers, from its scorecard rows.
 *
 * The exclusion order matters and is not interchangeable: a row that cannot be tied to this plan's
 * task cannot be scored for it at all, a row whose plan task declares no verify command is the
 * exclusion criteria 2 and 3 anticipate, and a row with no verify result is a run that produced no
 * evidence. All three are counted separately so the printed report can say which one happened.
 */
function armMetrics(arm: AbArmInput, scored: Set<string>): AbArmMetrics {
  const buckets = emptyBuckets();
  const models: string[] = [];
  const seen = new Set<string>();
  const retries = new Map<string, AbRow>();
  for (const r of arm.retry_rows ?? []) if (r.plan_task) retries.set(r.plan_task, r);

  let runs = 0;
  let firstPassPassed = 0;
  let cost = 0;
  let excludedUnverified = 0;
  let excludedNoVerify = 0;
  let excludedUnmatched = 0;

  for (const r of arm.rows) {
    if (!r.plan_task || !scored.has(r.plan_task)) {
      if (r.plan_task && !scored.has(r.plan_task)) excludedNoVerify++;
      else excludedUnmatched++;
      continue;
    }
    seen.add(r.plan_task);
    cost += r.cost_usd;
    if (r.model && !models.includes(r.model)) models.push(r.model);
    if (r.verify_ok === null) {
      excludedUnverified++;
      continue;
    }
    runs++;
    if (r.verify_ok) firstPassPassed++;
    if (typeof r.confidence === "number") {
      const b = bucketFor(buckets, r.confidence);
      b.runs++;
      if (!r.verify_ok) b.failed++;
    }
  }

  let retried = 0;
  let retryPassed = 0;
  let retryMissing = 0;
  for (const r of arm.rows) {
    if (!r.plan_task || !scored.has(r.plan_task) || r.verify_ok !== false) continue;
    const retry = retries.get(r.plan_task);
    if (!retry || retry.verify_ok === null) {
      // A failure nobody retried is not evidence that a retry would have passed.
      retryMissing++;
      continue;
    }
    retried++;
    cost += retry.cost_usd;
    if (retry.model && !models.includes(retry.model)) models.push(retry.model);
    if (retry.verify_ok) retryPassed++;
  }

  for (const b of buckets) b.fail_pct = b.runs ? Math.round((b.failed / b.runs) * 100) : null;
  const afterRetryPassed = firstPassPassed + retryPassed;
  return {
    name: arm.name,
    label: arm.label,
    rows: arm.rows,
    runs,
    first_pass_passed: firstPassPassed,
    first_pass_pct: pct(firstPassPassed, runs),
    retried,
    retry_passed: retryPassed,
    retry_missing: retryMissing,
    after_retry_passed: afterRetryPassed,
    after_retry_pct: pct(afterRetryPassed, runs),
    excluded_unverified: excludedUnverified,
    excluded_no_verify: excludedNoVerify,
    excluded_unmatched: excludedUnmatched,
    missing: [...scored].filter((id) => !seen.has(id)).sort(),
    cost_usd: Math.round(cost * 1e6) / 1e6,
    models,
    buckets,
  };
}

/** What `toAbRows` needs from a ledger task: the join keys, and nothing else. */
export interface AbLedgerTask {
  id: string;
  /** The plan's own task id, written only by `run_plan`. */
  plan_task?: string;
  /** The routing engine's confidence in the lane it chose. */
  route_confidence?: number;
}

/**
 * Join one arm's scorecard lines to the ledger tasks that wrote them.
 *
 * The scorecard carries the ledger id, and the confidence lives on the task, so a pass rate can be
 * banded by confidence only through this join. A scorecard whose task is not in the map keeps
 * `plan_task: null` and `confidence: null` rather than guessing: `armMetrics` excludes such a row
 * from the rate instead of attributing it here.
 */
export function toAbRows(records: ScorecardRecord[], tasks: Map<string, AbLedgerTask>): AbRow[] {
  return records.map((r) => {
    const t = tasks.get(r.task);
    return {
      task: r.task,
      plan_task: t?.plan_task ?? null,
      lane: r.lane,
      verify_ok: r.verify_ok ?? null,
      attempts: Number(r.attempts ?? 1),
      cost_usd: Number(r.cost_usd ?? 0),
      confidence: typeof t?.route_confidence === "number" ? t.route_confidence : null,
      model: r.model ?? "",
    };
  });
}

/** Criterion 8's arithmetic: the >=0.8 band must fail at most half as often as the <0.5 band. */
export function calibrationHolds(high: AbBucket, low: AbBucket): boolean | null {
  if (!high.runs || !low.runs) return null;
  return high.failed / high.runs <= 0.5 * (low.failed / low.runs);
}

/**
 * The comparison, from scorecard rows only.
 *
 * The gap is `routed - strong` and the criterion band is absolute: 5 points either way. Beating
 * all-strong is not a failure, but the sign is printed with the number so a reader sees which side
 * of the band it fell on instead of reading "within 5 pts" and assuming a loss.
 */
export function summariseAb(plan: { tasks: AbPlanTask[] }, inputs: AbArmInput[]): AbReport {
  const scored = new Set(plan.tasks.filter((t) => (t.verify ?? "").trim()).map((t) => t.id));
  const excludedNoVerify = plan.tasks.filter((t) => !(t.verify ?? "").trim()).map((t) => t.id);
  const arms = Object.fromEntries(inputs.map((a) => [a.name, armMetrics(a, scored)])) as Record<AbArmName, AbArmMetrics>;

  const criterion = (routed: number | null, strong: number | null, target: string): AbCriterion => {
    if (routed === null || strong === null) {
      const who = routed === null && strong === null ? "neither arm" : routed === null ? "the routed arm" : "the all-strong arm";
      return { routed_pct: routed, strong_pct: strong, gap_pts: null, target, verdict: "NOT MEASURED", note: `${who} produced a scored run, so there is no gap to compute` };
    }
    const gap = round1(routed - strong);
    const within = Math.abs(gap) <= AB_TOLERANCE_PTS;
    return { routed_pct: routed, strong_pct: strong, gap_pts: gap, target, verdict: within ? "PASS" : "MISS", note: within ? null : `routed is ${Math.abs(gap)} pts ${gap < 0 ? "below" : "above"} all-strong` };
  };

  const [low, mid, high] = arms.routed.buckets;
  const holds = calibrationHolds(high, low);
  const calibrationNote =
    holds !== null
      ? null
      : low.runs === 0 && high.runs === 0
        ? "no routed run carried a confidence — the routed arm either never ran or the engine answered without one, so there is nothing to band"
        : low.runs === 0
          ? "the <0.5 band is empty: routing sends a task below routing.threshold back to the lead instead of running it, so no low-confidence failure can be observed. Lower the threshold to measure this band — never read a rate out of an empty band."
          : "the >=0.8 band is empty: nothing was routed at high confidence, so there is no high-confidence failure rate to compare";

  const criteria = {
    first_pass: criterion(arms.routed.first_pass_pct, arms.strong.first_pass_pct, `within ${AB_TOLERANCE_PTS} pts`),
    after_retry: criterion(arms.routed.after_retry_pct, arms.strong.after_retry_pct, `within ${AB_TOLERANCE_PTS} pts`),
    calibration: {
      high,
      mid,
      low,
      holds,
      verdict: (holds === null ? "NOT MEASURED" : holds ? "PASS" : "MISS") as AbVerdict,
      note: calibrationNote,
    },
  };

  const missed: string[] = [];
  if (criteria.first_pass.verdict === "MISS") missed.push("criterion 2 (first-pass verify rate)");
  if (criteria.after_retry.verdict === "MISS") missed.push("criterion 3 (verify rate after one retry)");
  if (criteria.calibration.verdict === "MISS") missed.push("criterion 8 (calibration)");
  const unmeasured: string[] = [];
  if (criteria.first_pass.verdict === "NOT MEASURED") unmeasured.push("criterion 2 (first-pass verify rate)");
  if (criteria.after_retry.verdict === "NOT MEASURED") unmeasured.push("criterion 3 (verify rate after one retry)");
  if (criteria.calibration.verdict === "NOT MEASURED") unmeasured.push("criterion 8 (calibration)");

  return {
    plan_tasks: plan.tasks.length,
    scored_tasks: scored.size,
    excluded_no_verify: excludedNoVerify,
    arms,
    criteria,
    missed,
    unmeasured,
    verdict: verdictFor(arms, criteria, excludedNoVerify.length),
  };
}

/** The sentence the issue depends on. A partial result must not read as a clean one. */
function verdictFor(arms: Record<AbArmName, AbArmMetrics>, criteria: AbReport["criteria"], noVerify: number): string {
  const notRun = `${arms.routed.missing.length + arms.strong.missing.length} task(s) produced no scorecard row in an arm`;
  const excluded = `excluded: ${arms.routed.excluded_unverified + arms.strong.excluded_unverified} row(s) with no verify result${noVerify ? `, ${noVerify} plan task(s) with no verify command` : ""}`;
  if (arms.routed.runs + arms.strong.runs === 0) {
    return `nothing was measured: no scorecard with a verify result for either arm, so every criterion is NOT MEASURED rather than passed. ${notRun}; ${excluded}.`;
  }
  if (criteria.first_pass.verdict === "MISS" || criteria.after_retry.verdict === "MISS") {
    return `the routed arm is behind all-strong by more than ${AB_TOLERANCE_PTS} points on verify (first pass ${criteria.first_pass.gap_pts ?? "?"} pts, after one retry ${criteria.after_retry.gap_pts ?? "?"} pts). ${notRun}; ${excluded}.`;
  }
  return `no criterion missed its target on this plan: routed ${arms.routed.first_pass_pct}% first pass against all-strong ${arms.strong.first_pass_pct}%, calibration ${criteria.calibration.verdict.toLowerCase()}. ${notRun}; ${excluded}.`;
}

/**
 * 0 when every criterion was measured and held; 1 when one was MISSED, or when nothing was measured
 * at all. An unmeasured criterion on its own (an empty calibration band, which routing's own
 * threshold makes structural) is printed loudly but does not by itself fail the run.
 */
export function abExitCode(r: AbReport): number {
  if (r.missed.length) return 1;
  return r.arms.routed.runs + r.arms.strong.runs === 0 ? 1 : 0;
}

/** The `routing_savings` block of `cost_report`, which is another process's answer — read by field. */
export interface AbSavings {
  measured?: boolean;
  reason?: string;
  actual_crew_usd?: number;
  all_strong_replay_usd?: number;
  saved_pct?: number;
  routing?: { usd?: number };
}

export interface AbMeta {
  workspace: string;
  plan: string;
  /** What arm A ran: the engine, and where it came from. */
  engine: string;
  /** The model the `strong` alias resolved to, which is what arm B pinned every lane to. */
  strong: string;
  /** The `routing_savings` block from `cost_report`, if the report could be fetched. */
  savings?: AbSavings;
}

const TASK_BASENAME = (p: string) => p.split("/").pop() ?? p;

export function renderAb(r: AbReport, meta: AbMeta): string {
  const rate = (p: number | null, passed: number, runs: number) => (p === null ? "no scored runs" : `${p}% (${passed}/${runs})`);
  const band = (b: AbBucket) => (b.fail_pct === null ? `${b.bucket}: no runs` : `${b.bucket}: ${b.fail_pct}% failed of ${b.runs}`);
  const armLine = (a: AbArmMetrics) =>
    `  ${a.name.padEnd(7)} ${rate(a.first_pass_pct, a.first_pass_passed, a.runs).padEnd(18)} first pass · ${rate(a.after_retry_pct, a.after_retry_passed, a.runs).padEnd(18)} after one retry · ${a.retried} retried (${a.retry_missing} with no retry) · $${a.cost_usd.toFixed(6)} over ${a.rows.length} row(s) · models: ${a.models.join(", ") || "none"}`;
  const critLine = (c: AbCriterion, title: string) => {
    const gap = c.gap_pts === null ? "gap not computable" : `gap ${c.gap_pts > 0 ? "+" : ""}${c.gap_pts} pts`;
    return `  ${title} routed ${c.routed_pct === null ? "no runs" : `${c.routed_pct}%`} vs all-strong ${c.strong_pct === null ? "no runs" : `${c.strong_pct}%`} — ${gap} (target: ${c.target}) — ${c.verdict}${c.note ? ` · ${c.note}` : ""}`;
  };
  const cal = r.criteria.calibration;
  const byTask = new Map<string, Partial<Record<AbArmName, AbRow>>>();
  for (const name of ["routed", "strong"] as AbArmName[])
    for (const row of r.arms[name].rows) {
      if (!row.plan_task) continue;
      const e = byTask.get(row.plan_task) ?? {};
      e[name] = row;
      byTask.set(row.plan_task, e);
    }
  const order = [...byTask.keys()].sort();
  for (const id of r.excluded_no_verify) if (!byTask.has(id)) order.push(id);
  const w = Math.max(18, ...order.map((k) => k.length));
  const cell = (row: AbRow | undefined) => (!row ? "not run" : row.verify_ok === null ? "no verify" : `${row.verify_ok ? "pass" : "FAIL"} (${row.lane})`);
  const rows = order.map((id) => {
    const e = byTask.get(id) ?? {};
    return `  ${id.padEnd(w)}  ${cell(e.routed).padEnd(20)}  ${cell(e.strong)}${r.excluded_no_verify.includes(id) ? "   <- no verify command: excluded from criteria 2 and 3" : ""}`;
  });
  const savings = meta.savings;
  const savingsLine = !savings
    ? "  cost_report: not fetched, so no routing_savings figure is quoted"
    : savings.measured === false
      ? `  cost_report routing_savings (this window, every call in it): NOT MEASURED — ${savings.reason ?? "the report gave no reason"}`
      : `  cost_report routing_savings (this window, every call in it — not only these two arms): actual crew $${savings.actual_crew_usd}, all-strong replay $${savings.all_strong_replay_usd}, saved ${savings.saved_pct}% · routing itself $${savings.routing?.usd ?? "?"}`;
  return [
    "# bf ab — one plan, two arms, one commit",
    "",
    `workspace ${meta.workspace}`,
    `plan ${TASK_BASENAME(meta.plan)} — ${r.plan_tasks} task(s), ${r.scored_tasks} with a verify command`,
    `arm A routed: ${meta.engine}   arm B all-strong: every lane pinned to ${meta.strong}`,
    "",
    `  ${"task".padEnd(w)}  ${"routed".padEnd(20)}  strong`,
    `  ${"-".repeat(w)}  ${"-".repeat(20)}  ${"-".repeat(20)}`,
    ...rows,
    "",
    "## Verify results per arm",
    "",
    "  pass/fail is the scorecard `verify_ok` field — the gateway's own verify exit code. No worker's report text is read, and a row the scorecard left unverified is excluded rather than counted as a pass.",
    armLine(r.arms.routed),
    armLine(r.arms.strong),
    ...(r.excluded_no_verify.length ? [`  excluded: no verify command on ${r.excluded_no_verify.join(", ")} — they cannot contribute to criteria 2 or 3`] : []),
    ...(r.arms.routed.missing.length + r.arms.strong.missing.length
      ? [`  no scorecard row: routed [${r.arms.routed.missing.join(", ") || "-"}] strong [${r.arms.strong.missing.join(", ") || "-"}]`]
      : []),
    "",
    "## Criteria",
    "",
    critLine(r.criteria.first_pass, "criterion 2  first-pass verify:"),
    critLine(r.criteria.after_retry, "criterion 3  after one retry: "),
    `  criterion 8  confidence vs verify: ${r.arms.routed.buckets.map(band).join(" · ")}`,
    cal.holds === null
      ? `               NOT MEASURED — ${cal.note}`
      : `               the >=0.8 band failed ${cal.high.fail_pct}% of ${cal.high.runs} against ${cal.low.fail_pct}% of ${cal.low.runs} below 0.5 — ${cal.holds ? "at most half, as the criterion requires (PASS)" : "MORE than half — MISS"}`,
    "",
    "## Spend",
    "",
    `  routed $${r.arms.routed.cost_usd.toFixed(6)} · all-strong $${r.arms.strong.cost_usd.toFixed(6)} — the scorecard cost_usd of each arm's own rows, so this is what the arms actually spent`,
    savingsLine,
    "",
    `VERDICT  ${r.verdict}`,
  ].join("\n");
}
