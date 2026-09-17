/**
 * Harness sub-agents over tmux.
 *
 * Spawn another coding harness (Claude Code, Codex, omp, pi, grok, …) inside a
 * detached tmux session — a real PTY — and drive it by writing keystrokes, so the
 * sub-agent runs in the user's interactive/subscription mode instead of
 * `claude -p "<prompt>"` (print mode bills the API per token). Sessions are
 * persisted so a lead can list, read, send to and resume them later.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { GatewayConfig } from "./config.js";

const exec = promisify(execFile);

export interface HarnessSession {
  id: string;
  /** tmux session name */
  tmux: string;
  /** CLI command that owns the session (claude, codex, omp, pi, grok, …) */
  harness: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | "exited";
}

export class HarnessController {
  private dir: string;
  private mem = new Map<string, HarnessSession>();
  constructor(private config: GatewayConfig, private stateless: boolean) {
    this.dir = path.join(config.sessionDir!, "harness");
    if (!stateless) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private tmux(): string {
    return process.env.BREAK_FREE_TMUX || this.config.harness.tmux;
  }
  private name(id: string): string {
    return `${this.config.harness.sessionPrefix}${id}`;
  }
  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }
  private load(id: string): HarnessSession | undefined {
    if (this.stateless) return this.mem.get(id);
    try { return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as HarnessSession; } catch { return undefined; }
  }
  private save(s: HarnessSession): void {
    if (this.stateless) this.mem.set(s.id, s);
    else fs.writeFileSync(this.file(s.id), JSON.stringify(s, null, 2) + "\n");
  }
  private must(id: string): HarnessSession {
    const s = this.load(id);
    if (!s) throw new Error(`no harness session "${id}" — run harness_list to see active sessions`);
    return s;
  }

  private async tmuxRun(args: string[]): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout } = await exec(this.tmux(), args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, out: stdout ?? "" };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { ok: false, out: err.stderr ?? err.message ?? String(e) };
    }
  }

  /** Open a detached tmux session running the harness CLI (interactive PTY). */
  async spawn(harness: string, opts: { cwd?: string; command?: string } = {}): Promise<HarnessSession> {
    const id = randomBytes(6).toString("hex");
    const cwd = path.resolve(opts.cwd ?? this.config.workspaceRoot ?? process.cwd());
    const cmd = (opts.command ?? harness).trim();
    if (!cmd || /[\r\n]/.test(cmd)) throw new Error("harness command must be a single non-empty line");
    const r = await this.tmuxRun(["new-session", "-d", "-s", this.name(id), "-c", cwd, cmd]);
    if (!r.ok) throw new Error(`tmux new-session failed: ${r.out.trim() || "is tmux installed?"}`);
    const s: HarnessSession = { id, tmux: this.name(id), harness, cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "running" };
    this.save(s);
    return s;
  }

  /** Write literal keystrokes into the session (optionally followed by Enter). */
  async send(id: string, text: string, enter = true): Promise<void> {
    const s = this.must(id);
    const r = await this.tmuxRun(["send-keys", "-t", s.tmux, "-l", text]);
    if (!r.ok) throw new Error(`tmux send-keys failed: ${r.out.trim()}`);
    if (enter) await this.tmuxRun(["send-keys", "-t", s.tmux, "Enter"]);
    s.updatedAt = new Date().toISOString();
    this.save(s);
  }

  /** Capture the pane text (last `lines` lines of scrollback). */
  async read(id: string, lines = 400): Promise<string> {
    const s = this.must(id);
    const r = await this.tmuxRun(["capture-pane", "-p", "-t", s.tmux, "-S", `-${Math.max(1, lines)}`]);
    if (!r.ok) throw new Error(`tmux capture-pane failed: ${r.out.trim()}`);
    return r.out;
  }

  async status(id: string): Promise<"running" | "exited" | "unknown"> {
    const s = this.load(id);
    if (!s) return "unknown";
    const running = (await this.tmuxRun(["has-session", "-t", s.tmux])).ok;
    const next: HarnessSession["state"] = running ? "running" : "exited";
    if (s.state !== next) { s.state = next; s.updatedAt = new Date().toISOString(); this.save(s); }
    return next;
  }

  /** Kill the tmux session (closes the sub-agent). */
  async close(id: string): Promise<boolean> {
    const s = this.load(id);
    if (!s) return false;
    const ok = (await this.tmuxRun(["kill-session", "-t", s.tmux])).ok;
    s.state = "exited"; s.updatedAt = new Date().toISOString(); this.save(s);
    return ok;
  }

  /** Every tracked session, newest first, reconciled against live tmux. */
  async list(): Promise<HarnessSession[]> {
    const out: HarnessSession[] = [];
    if (this.stateless) {
      for (const s of this.mem.values()) out.push(s);
    } else if (fs.existsSync(this.dir)) {
      for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
        try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as HarnessSession); } catch { /* skip corrupt */ }
      }
    }
    for (const s of out) {
      const running = (await this.tmuxRun(["has-session", "-t", s.tmux])).ok;
      const next: HarnessSession["state"] = running ? "running" : "exited";
      if (s.state !== next) { s.state = next; this.save(s); }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
