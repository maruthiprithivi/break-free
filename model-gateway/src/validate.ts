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

export type ValidateArm = "claimed" | "lead" | "jev";

export interface TaskOutcome {
  task: string;
  arm: ValidateArm;
  /** The lane the run was pinned to. */
  lane: string;
  /** The gateway's own verify result. `null` when the task reported no verify command. */
  verify_ok: boolean | null;
  /** The model that actually answered. */
  model: string;
  ms: number;
  error?: string;
}

export interface ArmValidation {
  runs: number;
  passed: number;
  failed: number;
  unverified: number;
  errored: number;
  pass_pct: number;
  /** Distinct models that answered, so "the same lane" is visible in the output. */
  models: string[];
}

export interface ValidationReport {
  tasks: number;
  runs: number;
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
  /** Where the lanes came from, for the footer. */
  lane_map: Record<string, string | null>;
}

export function laneFor(config: GatewayConfig, lane: string): string | null {
  return (config.routing.laneMap[lane] ?? DEFAULT_LANE_MAP[lane]) ?? null;
}

export function summarise(outcomes: TaskOutcome[], tasks: ValidateTask[], config: GatewayConfig): ValidationReport {
  const arms: Record<ValidateArm, ArmValidation> = {
    claimed: emptyArm(),
    lead: emptyArm(),
    jev: emptyArm(),
  };
  for (const o of outcomes) {
    const a = arms[o.arm];
    a.runs++;
    if (o.error) a.errored++;
    else if (o.verify_ok === true) a.passed++;
    else if (o.verify_ok === false) a.failed++;
    else a.unverified++;
    if (o.model && !a.models.includes(o.model)) a.models.push(o.model);
  }
  for (const a of Object.values(arms)) a.pass_pct = a.runs ? Math.round((a.passed / a.runs) * 100) : 0;

  const claimed = outcomes.filter((o) => o.arm === "claimed" && !o.error && o.verify_ok !== null);
  const passed = claimed.filter((o) => o.verify_ok === true).length;
  const failed = claimed.length - passed;
  const passPct = claimed.length ? Math.round((passed / claimed.length) * 100) : 0;
  const labelsHold = claimed.length > 0 && failed === 0;

  return {
    tasks: tasks.length,
    runs: outcomes.length,
    arms,
    label_validation: { checked: claimed.length, passed, failed, pass_pct: passPct, labels_hold: labelsHold },
    verdict: verdictFor(claimed.length, passed, failed, arms),
    rows: outcomes,
    lane_map: Object.fromEntries(tasks.flatMap((t) => [[t.cheapest_passing_lane, laneFor(config, t.cheapest_passing_lane)], [t.lane, laneFor(config, t.lane)]] as [string, string | null][])),
  };
}

function emptyArm(): ArmValidation {
  return { runs: 0, passed: 0, failed: 0, unverified: 0, errored: 0, pass_pct: 0, models: [] };
}

/**
 * The sentence the write-up depends on. Worded so a partial result cannot be read as a clean one:
 * a lane that fails even once on the work it was supposed to handle is not a cheap lane.
 */
function verdictFor(checked: number, passed: number, failed: number, arms: Record<ValidateArm, ArmValidation>): string {
  if (checked === 0) return "nothing was verified — every run was unverified or errored, so this says nothing about the labels";
  const jev = arms.jev.runs ? ` Jev's own lane passed ${arms.jev.passed}/${arms.jev.runs}.` : "";
  if (failed === 0) {
    return `the labelled cheapest lane passed verify in all ${checked} checked runs, so the savings estimate is not yet contradicted.${jev}`;
  }
  return `the labelled cheapest lane FAILED verify in ${failed} of ${checked} checked runs (${passed} passed), so the labels are optimistic and any savings figure built on them is inflated until they are corrected.${jev}`;
}

export function renderValidation(r: ValidationReport, meta: { workspace: string; set: string; withRouting: boolean }): string {
  const w = Math.max(18, ...r.rows.map((row) => row.task.length));
  const pad = (s: string, n: number) => s.padEnd(n);
  const cell = (o: TaskOutcome | undefined) => (o ? `${o.verify_ok === true ? "pass" : o.verify_ok === false ? "FAIL" : "n/a"} (${o.lane})` : "-");
  const byTask = new Map<string, Partial<Record<ValidateArm, TaskOutcome>>>();
  for (const o of r.rows) {
    const e = byTask.get(o.task) ?? {};
    e[o.arm] = o;
    byTask.set(o.task, e);
  }
  const armCols: ValidateArm[] = meta.withRouting ? ["claimed", "lead", "jev"] : ["claimed", "lead"];
  return [
    `# bf validate — do the labels hold?`,
    "",
    `workspace ${meta.workspace}`,
    `${r.tasks} tasks from ${meta.set}, ${r.runs} real runs with the gateway's own verify`,
    "",
    `  ${pad("task", w)}  ${armCols.map((a) => pad(a, 20)).join("  ").trimEnd()}`,
    `  ${"-".repeat(w)}  ${armCols.map(() => "-".repeat(20)).join("  ").trimEnd()}`,
    ...[...byTask].map(([id, byArm]) => `  ${pad(id, w)}  ${armCols.map((a) => pad(cell(byArm[a]), 20)).join("  ").trimEnd()}`),
    "",
    "## Verify results per arm",
    "",
    ...armCols.map((a) => `  ${pad(a, 8)} ${r.arms[a].passed} passed, ${r.arms[a].failed} failed, ${r.arms[a].unverified} unverified, ${r.arms[a].errored} errored  (${r.arms[a].pass_pct}% pass of ${r.arms[a].runs})  models: ${r.arms[a].models.join(", ") || "-"}`),
    "",
    "## Label validation",
    "",
    `  claimed cheapest lane: ${r.label_validation.passed}/${r.label_validation.checked} passed (${r.label_validation.pass_pct}%)`,
    `  VERDICT  ${r.verdict}`,
    "",
    `lanes come from ${Object.entries(r.lane_map).map(([k, v]) => `${k}->${v ?? "lead"}`).join(", ")}`,
  ].join("\n");
}
