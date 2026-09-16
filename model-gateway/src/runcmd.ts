/**
 * Restricted command execution for workers (`run` capability) and for the
 * gateway's own verification step (`delegate.verify`, `run_plan.tasks[].verify`).
 *
 * Rules, enforced by construction:
 *   - no shell: the command is split on whitespace and passed to execFile
 *   - the leading words must match one of config.workers.allowedCommands
 *   - no shell metacharacters anywhere (; & | < > ` $ newline)
 *   - runs inside the workspace root with a timeout and an output cap
 */
import { execFile } from "node:child_process";
import type { GatewayConfig } from "./config.js";
import type { WorkerTool } from "./workspace.js";

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal?: string | null;
  ms: number;
  output: string; // stdout+stderr interleaved as received, capped
  truncated: boolean;
  timedOut: boolean;
}

const META = /[;&|<>`$\n\r\\]/;

/** Split a command line into argv. Supports "double" and 'single' quoted words without escapes. */
export function splitArgv(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function isAllowedCommand(config: GatewayConfig, cmd: string): { ok: boolean; reason?: string } {
  if (!cmd.trim()) return { ok: false, reason: "empty command" };
  if (META.test(cmd)) return { ok: false, reason: "shell metacharacters (; & | < > ` $ \\ newline) are not allowed — commands run without a shell" };
  const words = splitArgv(cmd);
  if (words.some((w) => w.includes("..") && w.startsWith("/"))) return { ok: false, reason: "absolute paths with '..' are not allowed" };
  for (const allowed of config.workers.allowedCommands) {
    const a = allowed.trim().split(/\s+/);
    if (a.length && a.every((w, i) => words[i] === w)) return { ok: true };
  }
  return { ok: false, reason: `not in workers.allowedCommands (allowed prefixes: ${config.workers.allowedCommands.join(" | ")})` };
}

export async function runCommand(config: GatewayConfig, cwd: string, cmd: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const check = isAllowedCommand(config, cmd);
  if (!check.ok) throw new Error(`command refused: ${check.reason}`);
  const argv = splitArgv(cmd);
  const cap = config.workers.maxCommandOutputBytes;
  const timeoutMs = opts.timeoutMs ?? config.workers.commandTimeoutMs;
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    const child = execFile(argv[0], argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: cap * 4,
      signal: opts.signal,
      env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
    }, (err, _stdout, _stderr) => {
      const e = err as (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
      if (e?.killed && (e.signal === "SIGTERM" || e.signal === "SIGKILL") && Date.now() - started >= timeoutMs - 50) timedOut = true;
      const exitCode = e ? (typeof e.code === "number" ? e.code : null) : 0;
      resolve({ command: cmd, ok: !e, exitCode, signal: e?.signal ?? null, ms: Date.now() - started, output: output + (truncated ? `\n… output truncated at ${cap} bytes` : "") + (timedOut ? `\n… timed out after ${timeoutMs} ms` : "") + (e && e.code === "ENOENT" ? `\n(command not found: ${argv[0]})` : ""), truncated, timedOut });
    });
    const sink = (chunk: Buffer | string) => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > cap) {
        output = output.slice(0, cap);
        truncated = true;
      }
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
  });
}

export function runTool(config: GatewayConfig, cwd: string): WorkerTool {
  return {
    capability: "run",
    spec: {
      type: "function",
      function: {
        name: "run_command",
        description: `Run a build/test/lint command inside the workspace (no shell). Only these command prefixes are allowed: ${config.workers.allowedCommands.join(" | ")}. Returns exit code and captured output. Use it to verify your own work before reporting.`,
        parameters: { type: "object", properties: { command: { type: "string", description: "e.g. 'npm test', 'pytest tests/test_x.py -q'" }, timeout_ms: { type: "integer" } }, required: ["command"] },
      },
    },
    run: async (a) => {
      const r = await runCommand(config, cwd, String(a.command ?? ""), { timeoutMs: a.timeout_ms ? Math.min(Number(a.timeout_ms), config.workers.commandTimeoutMs) : undefined });
      return `$ ${r.command}\nexit=${r.exitCode ?? r.signal}${r.timedOut ? " (TIMED OUT)" : ""} in ${r.ms} ms\n${r.output || "(no output)"}`;
    },
  };
}
