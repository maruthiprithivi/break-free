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
import { atomicWrite } from "./atomic.js";

/** An exited session's record is dropped once tmux has confirmed it gone for this long. */
const EXITED_RETENTION_MS = 24 * 60 * 60 * 1000;
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

export function attachCommand(tmuxBin: string, s: HarnessSession): string {
  return `${tmuxBin} attach -t ${s.tmux}`;
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
  attach(s: HarnessSession): string {
    return attachCommand(this.tmux(), s);
  }
  attachFor(id: string): string | undefined {
    const s = this.load(id);
    return s ? this.attach(s) : undefined;
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
    else atomicWrite(this.file(s.id), JSON.stringify(s, null, 2) + "\n", 0o600);
  }
  private remove(id: string): void {
    if (this.stateless) this.mem.delete(id);
    else fs.rmSync(this.file(id), { force: true });
  }
  private must(id: string): HarnessSession {
    const s = this.load(id);
    if (!s) throw new Error(`no harness session "${id}" — run harness_list to see active sessions`);
    return s;
  }

  /**
   * Run tmux against the server the harness sessions actually live on, and say which of three
   * things happened.
   *
   * A gateway started inside a Claude swarm teammate pane inherits TMUX pointing at that swarm's
   * own tmux server. A bare `tmux has-session` then asked the wrong server, which truthfully said
   * "can't find session" - so live crewmates were recorded as exited and a false harness.exited
   * woke their sessions, then the next observer with the right server flipped them back. TMUX is
   * removed for every call here, so they all reach the default server the sessions were made on.
   *
   * And "tmux said no" is not the same as "tmux could not be asked". `absent` means tmux ran and
   * the session is not there. `unavailable` - not installed, timed out, anything else - means no
   * answer at all, and a caller must keep what it knew rather than record an exit.
   */
  private async tmuxRun(args: string[]): Promise<{ ok: boolean; absent?: boolean; unavailable?: boolean; out: string }> {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    try {
      const { stdout } = await exec(this.tmux(), args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env });
      return { ok: true, out: stdout ?? "" };
    } catch (e) {
      const err = e as { stderr?: string; message?: string; code?: string | number; killed?: boolean };
      const out = err.stderr ?? err.message ?? String(e);
      // tmux ran and said no - quietly, or with one of the ways it says "not there" - is absent.
      // It could not run (not installed, timed out), or ran and said something else (a client and
      // server from different tmux versions report a protocol mismatch), is no answer at all.
      const ran = !err.killed && err.code !== "ENOENT" && typeof err.code === "number";
      const said = (err.stderr ?? "").trim();
      const absent = ran && (said === "" || /can't find session|session not found|no such session|no server running|error connecting to/i.test(said));
      return { ok: false, out, ...(absent ? { absent: true } : { unavailable: true }) };
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
    const r = await this.tmuxRun(["has-session", "-t", s.tmux]);
    if (r.unavailable) return "unknown"; // could not ask: say so, and record nothing
    const next: HarnessSession["state"] = r.ok ? "running" : "exited";
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
    const retired = new Set<string>();
    for (const s of out) {
      const r = await this.tmuxRun(["has-session", "-t", s.tmux]);
      // No answer is not an exit. Recording one here is what woke sessions with a false
      // harness.exited whenever an observer could not reach tmux.
      if (r.unavailable) continue;
      const next: HarnessSession["state"] = r.ok ? "running" : "exited";
      if (s.state !== next) {
        s.state = next;
        s.updatedAt = new Date().toISOString();
        this.save(s);
      } else if (next === "exited" && Date.now() - Date.parse(s.updatedAt || s.createdAt) > EXITED_RETENTION_MS) {
        // Every record used to be probed at every turn end, forever. An exited one is kept - and
        // re-probed, which heals any that the wrong-server bug marked exited while still alive -
        // until the right server has confirmed it gone for a day. Then it goes.
        this.remove(s.id);
        retired.add(s.id);
      }
    }
    return out.filter((s) => !retired.has(s.id)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
