/**
 * `bf validate` — does the label data actually hold?
 *
 * The bench and the scenario comparison score against `cheapest_passing_lane`: the cheapest lane
 * that *should* still pass `verify`. Every cost and under-routing claim rests on that label being
 * true. Nothing so far has ever run a task on that lane to check.
 *
 * This does. For each task it runs the same work twice on a real repo — once on the lane the label
 * calls cheapest, once on the lane a skilled lead would pick — and reads the gateway's own verify
 * result. Nothing is inferred from worker prose: `verify_ok` is an exit code.
 *
 * Then it says the thing that matters: if the labelled cheapest lane does not actually pass, the
 * savings estimate is inflated and must not be published.
 *
 * A run whose verify fails is repeated ONCE, and both outcomes are kept (`first_attempt_ok` and
 * `verify_ok`, with `attempts`), because "does routing still pass after a retry" is a different
 * question from "does it pass first time" and a single pass/fail cannot answer both.
 *
 * The executor is injected, so the summary and the verdict are testable without spending money on
 * workers.
 */
import type { GatewayConfig } from "./config.js";
import { DEFAULT_LANE_MAP } from "./config.js";

export interface ValidateTask {
  id: string;
  task: string;
  acceptance?: string;
  verify?: string;
  files?: string[];
  tags?: string[];
  /** The lane a skilled lead would pick. */
  lane: string;
  /** The cheapest lane the label claims still passes `verify`. */
  cheapest_passing_lane: string;
}

/** A raw row from either set: `bench/route-set.jsonl` calls the lead's lane `lead_lane`. */
export type RawValidateTask = Omit<ValidateTask, "lane"> & { lane?: string; lead_lane?: string };

/**
 * Normalise rows from either shipped set into validate tasks, and refuse anything incomplete.
 *
 * The two datasets are different artefacts and kept their own field names; rather than rewrite 60
 * committed rows (and the decision recordings keyed off them), the difference is absorbed here.
 */
export function toValidateTasks(raw: RawValidateTask[]): ValidateTask[] {
  return raw
    .map((t) => ({ ...t, lane: t.lane ?? t.lead_lane ?? "" }))
    .filter((t) => t.id && t.task && t.verify && t.lane && t.cheapest_passing_lane) as ValidateTask[];
}

export type ValidateArm = "claimed" | "lead" | "jev";

export interface TaskOutcome {
  task: string;
  arm: ValidateArm;
  /** The lane the run was pinned to — for the routed arm, the lane the engine picked. */
  lane: string;
  /**
   * The engine's own confidence in the lane it picked. `null` for the label-driven arms, and for
   * anything that was never routed. This is the raw material of the calibration criterion: without
   * it there is nothing to bucket against the outcome.
   */
  confidence?: number | null;
  /**
   * The gateway's own verify result for the FIRST attempt, before any retry. Optional because a
   * caller that runs a task once has nothing to say about a second attempt; it then equals
   * `verify_ok`. `null` when the task reported no verify command.
   */
  first_attempt_ok?: boolean | null;
  /** The verify result after the retry pass. `null` when the task reported no verify command. */
  verify_ok: boolean | null;
  /** How many times this arm ran the task: 2 only when the first attempt failed verify and was retried. */
  attempts?: number;
  /** The model that actually answered. */
  model: string;
  ms: number;
  /**
   * The verify command's exit code when the gateway reported one. The verify metadata carries no
   * output, so this is the concrete thing a retry can be told about the failure it is repeating.
   */
  verify_exit?: number | null;
  /** Set when a run was attempted but produced no result (worker or provider error). */
  error?: string;
  /**
   * Set when nothing ran at all, with the real reason — the engine is off, or it handed the task
   * back to the lead. Never inferred from the absence of a lane: an unmapped lane and a routed
   * escalation are different problems and used to be reported as the same one.
   */
  not_run?: string;
}

export interface ArmValidation {
  /** Runs that produced a verify result — the header's "real runs". Attempts that errored and rows that never ran are counted separately, so a dead arm cannot look like a large measured one. */
  runs: number;
  passed: number;
  failed: number;
  unverified: number;
  /** Runs that were attempted but produced no result at all. */
  errored: number;
  /** Rows where nothing ran: the engine gave no lane. */
  not_run: number;
  /** The distinct reasons from those rows, so an arm that never ran can say why. */
  not_run_reasons: string[];
  /** `passed / runs` — after one retry. */
  pass_pct: number;
  /** Passed on the first attempt, with no retry needed. */
  first_pass_passed: number;
  /** `first_pass_passed / runs` — criterion 2's number. */
  first_pass_pct: number;
  /** Runs whose first attempt failed verify and were run a second time. */
  retried: number;
  /** Distinct models that answered, so "the same lane" is visible in the output. */
  models: string[];
}

/** One confidence band of executed routed runs, with what verify said about them. */
export interface ConfidenceBucket {
  bucket: "<0.5" | "0.5-0.8" | ">=0.8";
  runs: number;
  passed: number;
  failed: number;
  /** `null`, not 0, when nothing ran here: an empty bucket measures nothing. */
  fail_pct: number | null;
}

export interface ValidationReport {
  tasks: number;
  /** Executed runs — the header's count. Not the number of rows. */
  runs: number;
  /** Rows that were attempted and errored, and rows that never ran. */
  errored: number;
  not_run: number;
  /** Arms that produced no single verify result. A non-empty list means the run must not report success. */
  dead_arms: ValidateArm[];
  arms: Record<ValidateArm, ArmValidation>;
  /** The number this whole command exists to produce. */
  label_validation: {
    /** Runs where the labelled cheapest lane was expected to pass. */
    checked: number;
    passed: number;
    failed: number;
    pass_pct: number;
    /** `true` only when every checked claim held. */
    labels_hold: boolean;
  };
  verdict: string;
  rows: TaskOutcome[];
  /**
   * Tasks whose `verify` command already passed on the untouched tree, so it cannot discriminate:
   * the work is either unnecessary or the check is too weak. Excluded from the label maths — a
   * verify that cannot fail would report a clean result no matter what the worker did.
   */
  unfalsifiable: string[];
  /** Where the lanes came from, for the footer. */
  lane_map: Record<string, string | null>;
  /**
   * The brief's criteria, computed rather than narrated. Criterion 2 and 3 compare the routed arm
   * with the lane a skilled lead would pick; when every run of that arm was on the strong lane, the
   * comparison IS "against all-strong", and `comparator_is_all_strong` says so instead of leaving
   * the reader to assume it.
   */
  criteria: {
    /** Criterion 2: first-pass verify rate per arm, and the gap in percentage points. `null` where an arm ran nothing. */
    first_pass: { jev_pct: number | null; comparator_pct: number | null; gap_pts: number | null };
    /** Criterion 3: the same after one retry. */
    after_retry: { jev_pct: number | null; comparator_pct: number | null; gap_pts: number | null };
    comparator_is_all_strong: boolean;
    /** Criterion 8: confidence against a real verify outcome. `holds` is null when a bucket is empty — nothing is claimed from an empty bucket. */
    calibration: { high: ConfidenceBucket; low: ConfidenceBucket; holds: boolean | null; note: string | null };
  };
  /** The routed runs, banded by the engine's own confidence. Always the three bands, so an empty one is visible. */
  confidence_buckets: ConfidenceBucket[];
}

/**
 * Arms that produced no verify result at all: nothing ran, or every attempt errored.
 *
 * This is what decides the exit code. An arm can be a third of the matrix and be entirely dead —
 * the routing engine off, a provider key missing, a lane mapped to nothing — and the old check
 * (`label_validation.failed > 0`) reported success while the routed arm had never run.
 */
export function deadArms(arms: Record<ValidateArm, ArmValidation>): ValidateArm[] {
  return (["claimed", "lead", "jev"] as ValidateArm[]).filter((a) => arms[a].runs === 0 && arms[a].errored + arms[a].not_run > 0);
}

/** 0 when the run measured what it claims to; 1 when it did not. A dead arm outranks a clean label result. */
export function exitCodeFor(r: ValidationReport): number {
  return r.dead_arms.length || r.label_validation.failed > 0 ? 1 : 0;
}

export function laneFor(config: GatewayConfig, lane: string): string | null {
  return (config.routing.laneMap[lane] ?? DEFAULT_LANE_MAP[lane]) ?? null;
}

export function summarise(outcomes: TaskOutcome[], tasks: ValidateTask[], config: GatewayConfig, unfalsifiable: string[] = []): ValidationReport {
  const arms: Record<ValidateArm, ArmValidation> = {
    claimed: emptyArm(),
    lead: emptyArm(),
    jev: emptyArm(),
  };
  const skipped = new Set(unfalsifiable);
  const buckets: ConfidenceBucket[] = [
    { bucket: "<0.5", runs: 0, passed: 0, failed: 0, fail_pct: null },
    { bucket: "0.5-0.8", runs: 0, passed: 0, failed: 0, fail_pct: null },
    { bucket: ">=0.8", runs: 0, passed: 0, failed: 0, fail_pct: null },
  ];
  for (const o of outcomes) {
    if (skipped.has(o.task)) continue;
    const a = arms[o.arm];
    if (o.not_run) {
      // Never run: not a run, not a failure, and never silently dropped — the arm may be dead.
      a.not_run++;
      if (!a.not_run_reasons.includes(o.not_run)) a.not_run_reasons.push(o.not_run);
      continue;
    }
    if (o.error) {
      a.errored++;
      continue;
    }
    a.runs++;
    if ((o.attempts ?? 1) > 1) a.retried++;
    if ((o.first_attempt_ok === undefined ? o.verify_ok : o.first_attempt_ok) === true) a.first_pass_passed++;
    if (o.verify_ok === true) a.passed++;
    else if (o.verify_ok === false) a.failed++;
    else a.unverified++;
    if (o.model && !a.models.includes(o.model)) a.models.push(o.model);
    if (typeof o.confidence === "number") {
      const b = buckets[o.confidence < 0.5 ? 0 : o.confidence < 0.8 ? 1 : 2];
      b.runs++;
      if (o.verify_ok === true) b.passed++;
      else if (o.verify_ok === false) b.failed++;
    }
  }
  for (const a of Object.values(arms)) {
    a.pass_pct = a.runs ? Math.round((a.passed / a.runs) * 100) : 0;
    a.first_pass_pct = a.runs ? Math.round((a.first_pass_passed / a.runs) * 100) : 0;
  }
  for (const b of buckets) b.fail_pct = b.runs ? Math.round((b.failed / b.runs) * 100) : null;

  const claimed = outcomes.filter((o) => o.arm === "claimed" && !o.error && !o.not_run && o.verify_ok !== null && !skipped.has(o.task));
  const passed = claimed.filter((o) => o.verify_ok === true).length;
  const failed = claimed.length - passed;
  const passPct = claimed.length ? Math.round((passed / claimed.length) * 100) : 0;
  const labelsHold = claimed.length > 0 && failed === 0;
  const dead = deadArms(arms);
  const rows = outcomes.filter((o) => !skipped.has(o.task));
  // "all-strong" is checked rather than assumed: the lead arm only IS the all-strong comparison
  // when every one of its executed runs was on the strong lane.
  const leadRuns = rows.filter((o) => o.arm === "lead" && !o.error && !o.not_run);
  const comparatorIsAllStrong = leadRuns.length > 0 && leadRuns.every((o) => o.lane === "strong");
  const pct = (a: ArmValidation) => (a.runs ? a.pass_pct : null);
  const firstPct = (a: ArmValidation) => (a.runs ? a.first_pass_pct : null);
  const gap = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);
  const [low, high] = [buckets[0], buckets[2]];
  const calibrationHolds = low.runs && high.runs ? high.failed / high.runs <= 0.5 * (low.failed / low.runs) : null;

  return {
    tasks: tasks.length - skipped.size,
    runs: rows.filter((o) => !o.error && !o.not_run).length,
    errored: rows.filter((o) => o.error).length,
    not_run: rows.filter((o) => o.not_run).length,
    dead_arms: dead,
    arms,
    label_validation: { checked: claimed.length, passed, failed, pass_pct: passPct, labels_hold: labelsHold },
    verdict: verdictFor(claimed.length, passed, failed, arms, skipped.size, dead),
    rows,
    unfalsifiable: [...skipped],
    lane_map: Object.fromEntries(tasks.flatMap((t) => [[t.cheapest_passing_lane, laneFor(config, t.cheapest_passing_lane)], [t.lane, laneFor(config, t.lane)]] as [string, string | null][])),
    criteria: {
      first_pass: { jev_pct: firstPct(arms.jev), comparator_pct: firstPct(arms.lead), gap_pts: gap(firstPct(arms.jev), firstPct(arms.lead)) },
      after_retry: { jev_pct: pct(arms.jev), comparator_pct: pct(arms.lead), gap_pts: gap(pct(arms.jev), pct(arms.lead)) },
      comparator_is_all_strong: comparatorIsAllStrong,
      calibration: {
        high,
        low,
        holds: calibrationHolds,
        note:
          calibrationHolds !== null
            ? null
            : low.runs === 0 && high.runs === 0
              ? "no executed run carried a confidence — the routed arm never ran, so there is nothing to bucket"
              : low.runs === 0
                ? "the <0.5 band is empty: routing sends a task below routing.threshold back to the lead instead of running it, so no failure can be observed there. Lower the threshold to measure this band — do not read a rate out of an empty bucket."
                : "the >=0.8 band is empty: nothing was routed at high confidence, so there is no high-confidence failure rate to compare",
      },
    },
    confidence_buckets: buckets,
  };
}

function emptyArm(): ArmValidation {
  return { runs: 0, passed: 0, failed: 0, unverified: 0, errored: 0, not_run: 0, not_run_reasons: [], pass_pct: 0, first_pass_passed: 0, first_pass_pct: 0, retried: 0, models: [] };
}

/**
 * The sentence the write-up depends on. Worded so a partial result cannot be read as a clean one:
 * a lane that fails even once on the work it was supposed to handle is not a cheap lane, and an arm
 * that never ran is not evidence either way.
 */
function verdictFor(checked: number, passed: number, failed: number, arms: Record<ValidateArm, ArmValidation>, skipped: number, dead: ValidateArm[]): string {
  const partial = dead.length ? ` ${dead.join(" and ")} produced no verify result at all, so this is a partial result — see "Dead arms" before quoting it.` : "";
  if (checked === 0) {
    return (
      skipped > 0
        ? `nothing was checked: all ${skipped} task(s) had a verify command that already passed on the untouched tree, so it cannot tell whether the work was done. Point this at tasks whose verify actually fails first.`
        : "nothing was verified — every run was unverified or errored, so this says nothing about the labels"
    ) + partial;
  }
  const jev = arms.jev.runs ? ` Jev's own lane passed ${arms.jev.passed}/${arms.jev.runs}${arms.jev.retried ? ` (${arms.jev.first_pass_passed} of them first pass, ${arms.jev.retried} retried once)` : ""}.` : "";
  const handed = arms.jev.not_run ? ` ${arms.jev.not_run} task(s) on the Jev arm never ran: the router handed them back to the lead rather than guess a lane.` : "";
  if (failed === 0) {
    return `the labelled cheapest lane passed verify in all ${checked} checked runs, so the savings estimate is not yet contradicted.${jev}${handed}${partial}`;
  }
  return `the labelled cheapest lane FAILED verify in ${failed} of ${checked} checked runs (${passed} passed), so the labels are optimistic and any savings figure built on them is inflated until they are corrected.${jev}${handed}${partial}`;
}

export function renderValidation(r: ValidationReport, meta: { workspace: string; set: string; withRouting: boolean }): string {
  const w = Math.max(18, ...r.rows.map((row) => row.task.length));
  const pad = (s: string, n: number) => s.padEnd(n);
  const cell = (o: TaskOutcome | undefined) =>
    !o ? "-" : o.not_run ? "not run" : o.error ? `ERR (${o.lane})` : `${o.verify_ok === true ? "pass" : o.verify_ok === false ? "FAIL" : "n/a"} (${o.lane})`;
  const byTask = new Map<string, Partial<Record<ValidateArm, TaskOutcome>>>();
  for (const o of r.rows) {
    const e = byTask.get(o.task) ?? {};
    e[o.arm] = o;
    byTask.set(o.task, e);
  }
  const armCols: ValidateArm[] = meta.withRouting ? ["claimed", "lead", "jev"] : ["claimed", "lead"];
  // The header says how many runs produced a verify result. Errored and never-run rows are named
  // separately: counting them as runs is how a matrix with a third of it dead read as 30 real runs.
  const counts = [`${r.runs} real runs with the gateway's own verify`];
  if (r.errored) counts.push(`${r.errored} errored`);
  if (r.not_run) counts.push(`${r.not_run} not run`);
  const notRun = r.rows.filter((o) => o.not_run);
  const rate = (p: number | null) => (p === null ? "no runs" : `${p}%`);
  const gap = (g: number | null) => (g === null ? "not comparable: an arm ran nothing" : `gap ${g > 0 ? "+" : ""}${g} pts`);
  const band = (b: ConfidenceBucket) => (b.fail_pct === null ? `${b.bucket}: no runs` : `${b.bucket}: ${b.fail_pct}% failed of ${b.runs}`);
  const cal = r.criteria.calibration;
  const comparison = r.criteria.comparator_is_all_strong ? "lead (all-strong)" : "lead (NOT all-strong)";
  return [
    `# bf validate — do the labels hold?`,
    "",
    `workspace ${meta.workspace}`,
    `${r.tasks} tasks from ${meta.set}, ${counts.join(", ")}`,
    ...r.dead_arms.map((a) => `  !! DEAD ARM ${a}: not one run produced a verify result (${r.arms[a].errored} errored, ${r.arms[a].not_run} not run)${r.arms[a].not_run_reasons.length ? ` — ${r.arms[a].not_run_reasons.slice(0, 2).join("; ")}` : ""}`),
    "",
    `  ${pad("task", w)}  ${armCols.map((a) => pad(a, 20)).join("  ").trimEnd()}`,
    `  ${"-".repeat(w)}  ${armCols.map(() => "-".repeat(20)).join("  ").trimEnd()}`,
    ...[...byTask].map(([id, byArm]) => `  ${pad(id, w)}  ${armCols.map((a) => pad(cell(byArm[a]), 20)).join("  ").trimEnd()}`),
    "",
    "## Verify results per arm",
    "",
    ...armCols.map((a) => {
      const v = r.arms[a];
      return `  ${pad(a, 8)} ${v.passed} passed, ${v.failed} failed, ${v.unverified} unverified, ${v.errored} errored  (${v.pass_pct}% pass of ${v.runs})  ${v.first_pass_passed}/${v.runs} first pass, ${v.retried} retried, ${v.not_run} not run  models: ${v.models.join(", ") || "-"}`;
    }),
    ...(notRun.length ? ["", "## Not run", "", ...notRun.map((o) => `  ${pad(o.arm, 8)} ${pad(o.task, w)}  ${o.not_run}`)] : []),
    ...(meta.withRouting
      ? [
          "",
          "## Criteria",
          "",
          `  criterion 2  first-pass verify: jev ${rate(r.criteria.first_pass.jev_pct)} vs ${comparison} ${rate(r.criteria.first_pass.comparator_pct)} — ${gap(r.criteria.first_pass.gap_pts)} (target: within 5 pts)`,
          `  criterion 3  after one retry:  jev ${rate(r.criteria.after_retry.jev_pct)} vs ${comparison} ${rate(r.criteria.after_retry.comparator_pct)} — ${gap(r.criteria.after_retry.gap_pts)} (target: equal)`,
          `  criterion 8  confidence vs verify: ${r.confidence_buckets.map(band).join(" · ")}`,
          cal.holds === null
            ? `               NOT MEASURABLE — ${cal.note}`
            : `               the >=0.8 band failed ${cal.high.fail_pct}% of ${cal.high.runs} against ${cal.low.fail_pct}% of ${cal.low.runs} below 0.5 — ${cal.holds ? "at most half, as the criterion requires" : "MORE than half: the criterion is MISSED"}`,
        ]
      : []),
    "",
    "## Label validation",
    "",
    `  claimed cheapest lane: ${r.label_validation.passed}/${r.label_validation.checked} passed (${r.label_validation.pass_pct}%)`,
    `  VERDICT  ${r.verdict}`,
    ...(r.unfalsifiable.length ? ["", `  excluded as unfalsifiable (verify already passed before any work): ${r.unfalsifiable.join(", ")}`] : []),
    "",
    `lanes come from ${Object.entries(r.lane_map).map(([k, v]) => `${k}->${v ?? "lead"}`).join(", ")}`,
  ].join("\n");
}
