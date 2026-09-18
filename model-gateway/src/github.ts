/**
 * GitHub tools for delegated models, via the `gh` CLI (uses `gh auth login`
 * or GH_TOKEN). Every tool maps to a fixed, allow-listed gh invocation.
 *
 * Allowed:  issues (create/list/view/comment/close), PRs (create/list/view/
 *           comment/review/merge), Actions (list runs, view run, logs, rerun,
 *           list workflows), repo view.
 * Impossible by construction: repo delete/transfer/archive, branch delete,
 * secrets/variables, collaborators, releases delete, force pushes, `gh api`
 * with arbitrary paths.
 *
 * Recommended token: fine-grained PAT with Contents: RW, Issues: RW,
 * Pull requests: RW, Actions: RW, Workflows: RW, Metadata: R — nothing else.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "./config.js";
import { enqueueCi } from "./fleet.js";
import { enumArg, noFlag, strArray, type Workspace, type WorkerTool } from "./workspace.js";

const execFileP = promisify(execFile);

export async function ghAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFileP("gh", ["auth", "status"], { timeout: 15_000, env: process.env });
    return { ok: true, detail: stdout.trim().split("\n")[0] ?? "ok" };
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    if (err.code === "ENOENT") return { ok: false, detail: "gh CLI not installed (https://cli.github.com)" };
    return { ok: false, detail: (err.stderr || err.message).trim().slice(0, 300) };
  }
}

function asInt(v: unknown, name: string): string {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return String(n);
}

export function githubTools(config: GatewayConfig, ws: Workspace): WorkerTool[] {
  const gh = async (args: string[], timeoutMs = 60_000): Promise<string> => {
    const repoArgs = config.github.repo ? ["--repo", config.github.repo] : [];
    // --repo is only valid for some subcommands; callers pass `withRepo` positions via marker
    const finalArgs = args.flatMap((a) => (a === "__REPO__" ? repoArgs : [a]));
    try {
      const { stdout, stderr } = await execFileP("gh", finalArgs, { cwd: ws.root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
      return (stdout + (stderr ? `\n${stderr}` : "")).trim();
    } catch (e) {
      const err = e as { code?: string; stdout?: string; stderr?: string; message: string };
      if (err.code === "ENOENT") throw new Error("gh CLI not installed; see https://cli.github.com");
      throw new Error(`gh ${finalArgs[0]} ${finalArgs[1] ?? ""} failed: ${(err.stderr || err.stdout || err.message).trim().slice(0, 2000)}`);
    }
  };
  const t: WorkerTool[] = [];
  const add = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: WorkerTool["run"]) =>
    t.push({ capability: "github", spec: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, run });

  add("gh_repo_view", "Show the current repository (name, default branch, visibility).", {}, [], () =>
    gh(["repo", "view", "__REPO__", "--json", "nameWithOwner,defaultBranchRef,visibility,url", "--jq", "."]));

  // ---- issues
  add("gh_create_issue", "Create a GitHub issue.", {
    title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } },
  }, ["title", "body"], (a) => {
    const args = ["issue", "create", "__REPO__", "--title", String(a.title), "--body", String(a.body)];
    for (const l of strArray(a.labels, "labels")) args.push("--label", noFlag(l, "label"));
    for (const u of strArray(a.assignees, "assignees")) args.push("--assignee", noFlag(u, "assignee"));
    return gh(args);
  });
  add("gh_list_issues", "List open issues.", { state: { type: "string", enum: ["open", "closed", "all"] }, search: { type: "string" }, limit: { type: "integer" } }, [], (a) => {
    const args = ["issue", "list", "__REPO__", "--state", enumArg(a.state, ["open", "closed", "all"] as const, "state", "open"), "--limit", String(Math.min(Number(a.limit ?? 30), 100)), "--json", "number,title,state,labels,author,updatedAt", "--jq", ".[] | \"#\\(.number) [\\(.state)] \\(.title) (\\(.author.login), \\(.updatedAt))\""];
    if (a.search) args.push("--search", String(a.search));
    return gh(args);
  });
  add("gh_view_issue", "Read an issue and its comments.", { number: { type: "integer" } }, ["number"], (a) => gh(["issue", "view", asInt(a.number, "number"), "__REPO__", "--comments"]));
  add("gh_comment_issue", "Comment on an issue.", { number: { type: "integer" }, body: { type: "string" } }, ["number", "body"], (a) =>
    gh(["issue", "comment", asInt(a.number, "number"), "__REPO__", "--body", String(a.body)]));
  add("gh_close_issue", "Close an issue (reversible; not deletion).", { number: { type: "integer" }, comment: { type: "string" } }, ["number"], (a) => {
    const args = ["issue", "close", asInt(a.number, "number"), "__REPO__"];
    if (a.comment) args.push("--comment", String(a.comment));
    return gh(args);
  });

  // ---- pull requests
  add("gh_create_pr", "Open a pull request from the current (pushed) branch. Use git_create_branch → git_commit → git_push first.", {
    title: { type: "string" }, body: { type: "string" }, base: { type: "string", description: "Base branch (default: repo default branch)" }, draft: { type: "boolean" }, head: { type: "string", description: "Head branch (default: current)" },
  }, ["title", "body"], (a) => {
    const args = ["pr", "create", "__REPO__", "--title", String(a.title), "--body", String(a.body)];
    if (a.base) args.push("--base", noFlag(a.base, "base"));
    if (a.head) args.push("--head", noFlag(a.head, "head"));
    if (a.draft) args.push("--draft");
    return gh(args);
  });
  add("gh_list_prs", "List pull requests.", { state: { type: "string", enum: ["open", "closed", "merged", "all"] }, limit: { type: "integer" } }, [], (a) =>
    gh(["pr", "list", "__REPO__", "--state", enumArg(a.state, ["open", "closed", "merged", "all"] as const, "state", "open"), "--limit", String(Math.min(Number(a.limit ?? 30), 100)), "--json", "number,title,state,headRefName,baseRefName,author,isDraft,updatedAt", "--jq", ".[] | \"#\\(.number) [\\(.state)] draft=\\(.isDraft) \\(.title) \\(.headRefName)->\\(.baseRefName) (\\(.author.login), \\(.updatedAt))\""]));
  add("gh_view_pr", "Read a PR: description, checks, review state. Set diff=true to include the diff.", { number: { type: "integer" }, diff: { type: "boolean" } }, ["number"], async (a) => {
    const n = asInt(a.number, "number");
    const head = await gh(["pr", "view", n, "__REPO__", "--comments"]);
    const checks = await gh(["pr", "checks", n, "__REPO__"]).catch((e) => `checks: ${(e as Error).message}`);
    const d = a.diff ? await gh(["pr", "diff", n, "__REPO__"]) : "";
    const diff = d.length > config.workspace.maxFileBytes ? d.slice(0, config.workspace.maxFileBytes) + "\n… diff truncated" : d;
    return `${head}\n\n## Checks\n${checks}${diff ? `\n\n## Diff\n${diff}` : ""}`;
  });
  add("gh_comment_pr", "Comment on a PR.", { number: { type: "integer" }, body: { type: "string" } }, ["number", "body"], (a) =>
    gh(["pr", "comment", asInt(a.number, "number"), "__REPO__", "--body", String(a.body)]));
  add("gh_review_pr", "Submit a PR review: approve, request changes, or comment.", {
    number: { type: "integer" }, event: { type: "string", enum: ["approve", "request-changes", "comment"] }, body: { type: "string" },
  }, ["number", "event", "body"], (a) => {
    const ev = enumArg(a.event, ["approve", "request-changes", "comment"] as const, "event");
    const flag = ev === "approve" ? "--approve" : ev === "request-changes" ? "--request-changes" : "--comment";
    return gh(["pr", "review", asInt(a.number, "number"), "__REPO__", flag, "--body", String(a.body)]);
  });
  add("gh_merge_pr", "Merge a PR (squash by default). Never deletes the branch. Refused if github.allowMerge=false.", {
    number: { type: "integer" }, method: { type: "string", enum: ["squash", "merge", "rebase"] }, auto: { type: "boolean", description: "Enable auto-merge when checks pass instead of merging now" },
  }, ["number"], (a) => {
    if (!config.github.allowMerge) throw new Error("PR merging disabled by config (github.allowMerge=false)");
    const method = enumArg(a.method, ["squash", "merge", "rebase"] as const, "method", "squash");
    const args = ["pr", "merge", asInt(a.number, "number"), "__REPO__", `--${method}`]; // no --admin, no --delete-branch
    if (a.auto) args.push("--auto");
    return gh(args, 120_000).then(async (out) => {
      // Same reasoning as git_push: a merge starts a run on the base branch.
      // --auto merges later, so there is nothing to watch yet.
      if (!a.auto) {
        try {
          const sha = (await gh(["pr", "view", asInt(a.number, "number"), "__REPO__", "--json", "mergeCommit", "-q", ".mergeCommit.oid"], 30_000)).trim();
          if (sha && config.sessionDir) enqueueCi(config.sessionDir, { sha });
        } catch { /* the merge succeeded; bookkeeping must not undo that */ }
      }
      return out;
    });
  });

  // ---- actions
  add("gh_list_workflows", "List GitHub Actions workflows in the repo.", {}, [], () => gh(["workflow", "list", "__REPO__", "--all"]));
  add("gh_list_runs", "List recent workflow runs (optionally for one workflow file / branch).", {
    workflow: { type: "string", description: "e.g. ci.yml" }, branch: { type: "string" }, status: { type: "string", enum: ["queued", "in_progress", "completed", "success", "failure", "cancelled"] }, limit: { type: "integer" },
  }, [], (a) => {
    const args = ["run", "list", "__REPO__", "--limit", String(Math.min(Number(a.limit ?? 15), 50)), "--json", "databaseId,status,conclusion,name,headBranch,event,createdAt,url", "--jq", ".[] | \"\\(.databaseId) \\(.status)/\\(.conclusion // \\\"-\\\") \\(.name) [\\(.headBranch)] \\(.event) \\(.createdAt) \\(.url)\""];
    if (a.workflow) args.push("--workflow", noFlag(a.workflow, "workflow"));
    if (a.branch) args.push("--branch", noFlag(a.branch, "branch"));
    if (a.status) args.push("--status", enumArg(a.status, ["queued", "in_progress", "completed", "success", "failure", "cancelled"] as const, "status"));
    return gh(args);
  });
  add("gh_view_run", "Show a workflow run's jobs and steps. failed_only=true limits output to failed steps.", { run_id: { type: "integer" }, failed_only: { type: "boolean" } }, ["run_id"], (a) => {
    const args = ["run", "view", asInt(a.run_id, "run_id"), "__REPO__"];
    if (a.failed_only) args.push("--log-failed");
    return gh(args, 120_000);
  });
  add("gh_run_logs", "Fetch logs for a run (or a single job). Output is truncated; prefer failed_only in gh_view_run first.", { run_id: { type: "integer" }, job_id: { type: "integer" } }, ["run_id"], async (a) => {
    const args = a.job_id ? ["run", "view", "__REPO__", "--job", asInt(a.job_id, "job_id"), "--log"] : ["run", "view", asInt(a.run_id, "run_id"), "__REPO__", "--log"];
    const out = await gh(args, 180_000);
    return out.length > config.workspace.maxFileBytes ? out.slice(-config.workspace.maxFileBytes) + "\n… (tail shown)" : out;
  });
  add("gh_watch_run", "Block until a run finishes (up to ~4 minutes) and report its conclusion.", { run_id: { type: "integer" } }, ["run_id"], (a) =>
    gh(["run", "watch", asInt(a.run_id, "run_id"), "__REPO__", "--exit-status", "--interval", "10"], 240_000).catch((e) => `run finished with failure or timed out: ${(e as Error).message}`));
  add("gh_rerun_run", "Re-run a workflow run (optionally only failed jobs).", { run_id: { type: "integer" }, failed_only: { type: "boolean" } }, ["run_id"], (a) => {
    const args = ["run", "rerun", asInt(a.run_id, "run_id"), "__REPO__"];
    if (a.failed_only) args.push("--failed");
    return gh(args);
  });
  add("gh_trigger_workflow", "Dispatch a workflow (workflow_dispatch) on a branch.", { workflow: { type: "string" }, ref: { type: "string" }, inputs: { type: "object", additionalProperties: { type: "string" } } }, ["workflow"], (a) => {
    const args = ["workflow", "run", noFlag(a.workflow, "workflow"), "__REPO__"];
    if (a.ref) args.push("--ref", noFlag(a.ref, "ref"));
    const inputs = a.inputs && typeof a.inputs === "object" && !Array.isArray(a.inputs) ? (a.inputs as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(inputs)) {
      if (!/^[\w-]+$/.test(k)) throw new Error(`invalid input name ${k}`);
      args.push("-f", `${k}=${String(v)}`);
    }
    return gh(args);
  });

  return t;
}
