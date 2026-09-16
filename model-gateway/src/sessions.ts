/**
 * Session memory: conversation history per session_id, persisted as JSON so
 * a delegated model can be resumed across MCP restarts. `--stateless` keeps
 * everything in memory only.
 */
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./client.js";
import type { GatewayConfig } from "./config.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastModel?: string;
  turns: number;
  summary?: string;
}

export interface Session {
  meta: SessionMeta;
  messages: ChatMessage[]; // excludes the system prompt (recomputed per call)
}

export class SessionStore {
  private mem = new Map<string, Session>();
  constructor(private config: GatewayConfig, private stateless: boolean) {
    if (!stateless) fs.mkdirSync(config.sessionDir!, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    return path.join(this.config.sessionDir!, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  get(id: string): Session {
    let s = this.mem.get(id);
    if (s) return s;
    if (!this.stateless && fs.existsSync(this.file(id))) {
      try {
        s = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Session;
      } catch {
        s = undefined;
      }
    }
    if (!s) {
      const now = new Date().toISOString();
      s = { meta: { id, createdAt: now, updatedAt: now, turns: 0 }, messages: [] };
    }
    this.mem.set(id, s);
    return s;
  }

  save(s: Session): void {
    s.meta.updatedAt = new Date().toISOString();
    this.trim(s);
    this.mem.set(s.meta.id, s);
    if (!this.stateless) fs.writeFileSync(this.file(s.meta.id), JSON.stringify(s, null, 1), { mode: 0o600 });
  }

  clear(id: string): boolean {
    const had = this.mem.delete(id);
    if (!this.stateless && fs.existsSync(this.file(id))) {
      fs.unlinkSync(this.file(id));
      return true;
    }
    return had;
  }

  list(): SessionMeta[] {
    const metas = new Map<string, SessionMeta>();
    if (!this.stateless) {
      for (const f of fs.readdirSync(this.config.sessionDir!)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.config.sessionDir!, f), "utf8")) as Session;
          metas.set(s.meta.id, s.meta);
        } catch {
          /* skip */
        }
      }
    }
    for (const s of this.mem.values()) metas.set(s.meta.id, s.meta);
    return [...metas.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Keep the conversation within budget: drop oldest turns, keep tool-call pairs intact. */
  private trim(s: Session): void {
    const { maxSessionMessages, maxHistoryChars } = this.config.defaults;
    const size = () => s.messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length, 0);
    while (s.messages.length > maxSessionMessages || size() > maxHistoryChars) {
      if (s.messages.length <= 2) break;
      // drop the first message; if it is an assistant with tool_calls also drop its tool results
      const first = s.messages.shift()!;
      if (first.tool_calls) while (s.messages.length && s.messages[0].role === "tool") s.messages.shift();
      // history must start with a user turn (providers reject a leading assistant/tool message)
      while (s.messages.length > 1 && s.messages[0].role !== "user") s.messages.shift();
    }
  }
}
