/**
 * MCP bridge: lets delegated workers use the orchestrator's OTHER MCP servers.
 *
 * The gateway becomes an MCP *client* of servers that are
 *   - declared in config.workers.mcp.servers, or
 *   - discovered from the harness config the user already trusts:
 *       ~/.claude.json            (mcpServers, projects[<workspace>].mcpServers)
 *       <workspace>/.mcp.json     (Claude Code project servers)
 *       ~/.codex/config.toml      ([mcp_servers.<name>])
 * Its own registration (break-free-gateway / model-gateway) is always excluded.
 *
 * Nothing is exposed by default: the orchestrator passes `mcp_servers: [names]`
 * on each delegate/supervise/run_plan call, and only those servers' tools are
 * handed to the worker, minus config.workers.mcp.denyTools globs (delete/remove/
 * drop/destroy/purge… by default). Tools appear to the worker as
 * `mcp__<server>__<tool>` with the server's own input schema.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { GatewayConfig } from "./config.js";
import type { WorkerTool } from "./workspace.js";
import { log as rlog } from "./logger.js";

export interface McpServerDef {
  name: string;
  source: string; // config | claude-user | claude-project | mcp.json | codex
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  allowTools?: string[];
}

const SELF_NAMES = new Set(["break-free-gateway", "break_free_gateway", "model-gateway", "model_gateway"]);

function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => process.env[v] ?? "").replace(/^~(?=\/|$)/, os.homedir());
}
function expandRecord(r: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r ?? {})) if (typeof v === "string") out[k] = expandEnv(v);
  return out;
}

function fromJsonEntry(name: string, raw: unknown, source: string): McpServerDef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const j = raw as Record<string, unknown>;
  const type = String(j.type ?? (j.url ? "http" : "stdio"));
  if (type === "stdio" || (!j.url && j.command)) {
    if (typeof j.command !== "string") return undefined;
    return { name, source, transport: "stdio", command: expandEnv(j.command), args: Array.isArray(j.args) ? j.args.map((a) => expandEnv(String(a))) : [], env: expandRecord(j.env as Record<string, unknown>), cwd: typeof j.cwd === "string" ? expandEnv(j.cwd) : undefined, headers: {} };
  }
  if (typeof j.url === "string") return { name, source, transport: type === "sse" ? "sse" : "http", args: [], env: {}, url: expandEnv(j.url), headers: expandRecord(j.headers as Record<string, unknown>) };
  return undefined;
}

function readJsonSafe(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Minimal TOML reader for `[mcp_servers.<name>]` tables (strings, string arrays, inline string tables). */
export function parseCodexMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let cur: Record<string, unknown> | undefined;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const table = line.match(/^\[([^\]]+)\]\s*(#.*)?$/);
    if (table) {
      const seg = table[1].trim().match(/^mcp_servers\.("?)([^"\].]+)\1(\.(\w+))?$/);
      if (seg) {
        const name = seg[2];
        out[name] ??= {};
        cur = seg[4] ? ((out[name][seg[4]] as Record<string, unknown>) ??= {}) : out[name];
      } else cur = undefined;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    cur[kv[1]] = parseTomlValue(kv[2].trim());
  }
  return out;
}
function parseTomlValue(v: string): unknown {
  if (v.startsWith('"')) return v.match(/^"((?:[^"\\]|\\.)*)"/)?.[1].replace(/\\(.)/g, "$1") ?? v;
  if (v.startsWith("'")) return v.match(/^'([^']*)'/)?.[1] ?? v;
  if (v.startsWith("[")) return [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
  if (v.startsWith("{")) {
    const o: Record<string, unknown> = {};
    for (const m of v.matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) o[m[1]] = parseTomlValue(m[2]);
    return o;
  }
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/\s*#.*$/, "");
}

export function discoverMcpServers(config: GatewayConfig, wsRoot: string, home = os.homedir()): Record<string, McpServerDef> {
  const found: Record<string, McpServerDef> = {};
  const add = (d: McpServerDef | undefined) => {
    if (d && !SELF_NAMES.has(d.name) && !found[d.name]) found[d.name] = d;
  };
  // 1. explicit config wins
  for (const [name, s] of Object.entries(config.workers.mcp.servers)) {
    if (s.url) add({ name, source: "config", transport: "http", args: [], env: {}, url: expandEnv(s.url), headers: expandRecord(s.headers), allowTools: s.allowTools });
    else if (s.command) add({ name, source: "config", transport: "stdio", command: expandEnv(s.command), args: s.args.map(expandEnv), env: expandRecord(s.env), cwd: s.cwd ? expandEnv(s.cwd) : undefined, headers: {}, allowTools: s.allowTools });
  }
  if (!config.workers.mcp.discover) return found;
  // 2. Claude Code: user scope + local (per-project) scope
  const claude = readJsonSafe(path.join(home, ".claude.json"));
  if (claude) {
    const projects = (claude.projects ?? {}) as Record<string, Record<string, unknown>>;
    const proj = projects[wsRoot];
    for (const [n, raw] of Object.entries((proj?.mcpServers ?? {}) as Record<string, unknown>)) add(fromJsonEntry(n, raw, "claude-project"));
    for (const [n, raw] of Object.entries((claude.mcpServers ?? {}) as Record<string, unknown>)) add(fromJsonEntry(n, raw, "claude-user"));
  }
  // 3. Claude Code project file
  const mcpJson = readJsonSafe(path.join(wsRoot, ".mcp.json"));
  for (const [n, raw] of Object.entries((mcpJson?.mcpServers ?? {}) as Record<string, unknown>)) add(fromJsonEntry(n, raw, "mcp.json"));
  // 4. Codex (user + project)
  for (const file of [path.join(home, ".codex", "config.toml"), path.join(wsRoot, ".codex", "config.toml")]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const [n, raw] of Object.entries(parseCodexMcpServers(fs.readFileSync(file, "utf8")))) add(fromJsonEntry(n, raw, "codex"));
    } catch {
      /* ignore unreadable */
    }
  }
  return found;
}

export function globToRe(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

interface Connected {
  client: Client;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
}

export class McpBridge {
  private conns = new Map<string, Promise<Connected>>();
  constructor(private config: GatewayConfig, private wsRoot: string) {}

  servers(): Record<string, McpServerDef> {
    return discoverMcpServers(this.config, this.wsRoot);
  }

  private denied(tool: string, def: McpServerDef): string | undefined {
    if (this.config.workers.mcp.denyTools.some((g) => globToRe(g).test(tool))) return "denied by workers.mcp.denyTools";
    if (def.allowTools && !def.allowTools.some((g) => globToRe(g).test(tool))) return "not in server allowTools";
    return undefined;
  }

  async connect(name: string): Promise<Connected> {
    let p = this.conns.get(name);
    if (p) return p;
    p = (async () => {
      const def = this.servers()[name];
      if (!def) throw new Error(`unknown MCP server '${name}' (see list_mcp_servers)`);
      const client = new Client({ name: "break-free-gateway-bridge", version: "3.0.0" });
      const timeout = this.config.workers.mcp.connectTimeoutMs;
      const started = Date.now();
      try {
        if (def.transport === "stdio") {
          const transport = new StdioClientTransport({ command: def.command!, args: def.args, env: { ...(process.env as Record<string, string>), ...def.env }, cwd: def.cwd ?? this.wsRoot, stderr: "ignore" });
          await withTimeout(client.connect(transport), timeout, `connect to MCP server '${name}'`);
        } else if (def.transport === "sse") {
          await withTimeout(client.connect(new SSEClientTransport(new URL(def.url!), { requestInit: { headers: def.headers } })), timeout, `connect to MCP server '${name}'`);
        } else {
          await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(def.url!), { requestInit: { headers: def.headers } })), timeout, `connect to MCP server '${name}'`);
        }
        const tools: Connected["tools"] = [];
        let cursor: string | undefined;
        do {
          const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeout, `list tools of '${name}'`);
          for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} } });
          cursor = page.nextCursor;
        } while (cursor);
        rlog("mcp.connect", { server: name, source: def.source, ok: true, ms: Date.now() - started, tools: tools.length });
        return { client, tools };
      } catch (e) {
        rlog("mcp.connect", { server: name, source: def.source, ok: false, ms: Date.now() - started, error: String((e as Error).message).slice(0, 300) });
        this.conns.delete(name);
        try { await client.close(); } catch { /* ignore */ }
        throw e;
      }
    })();
    this.conns.set(name, p);
    return p;
  }

  /** Describe a server's tools (with deny status) without exposing anything. */
  async describe(name: string): Promise<{ name: string; source: string; transport: string; tools: { name: string; exposed: boolean; reason?: string; description?: string }[] }> {
    const def = this.servers()[name];
    if (!def) throw new Error(`unknown MCP server '${name}'`);
    const c = await this.connect(name);
    return { name, source: def.source, transport: def.transport, tools: c.tools.map((t) => { const reason = this.denied(t.name, def); return { name: t.name, exposed: !reason, reason, description: t.description?.slice(0, 200) }; }) };
  }

  /** Worker tools for the given servers. Unknown/unreachable servers throw so the orchestrator notices. */
  async toolsFor(names: string[], maxOutputBytes: number): Promise<WorkerTool[]> {
    const out: WorkerTool[] = [];
    const defs = this.servers();
    for (const name of names) {
      const def = defs[name];
      if (!def) throw new Error(`mcp_servers: unknown server '${name}'. Known: ${Object.keys(defs).join(", ") || "(none)"}`);
      const c = await this.connect(name);
      for (const t of c.tools) {
        if (this.denied(t.name, def)) continue;
        const exposedName = `mcp__${safe(name)}__${safe(t.name)}`;
        out.push({
          capability: "mcp",
          spec: { type: "function", function: { name: exposedName, description: `[${name}] ${t.description ?? t.name}`.slice(0, 1024), parameters: normaliseSchema(t.inputSchema) } },
          run: async (args) => {
            const started = Date.now();
            const res = await withTimeout(c.client.callTool({ name: t.name, arguments: args }), this.config.workers.mcp.callTimeoutMs, `${name}.${t.name}`);
            const content = (res.content as { type: string; text?: string; data?: string; mimeType?: string }[] | undefined) ?? [];
            let text = content.map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}${c.mimeType ? " " + c.mimeType : ""} omitted]`)).join("\n");
            if (!content.length && res.structuredContent) text = JSON.stringify(res.structuredContent);
            rlog("mcp.call", { server: name, tool: t.name, ok: !res.isError, ms: Date.now() - started, chars: text.length });
            if (res.isError) throw new Error(text.slice(0, maxOutputBytes) || "tool returned an error");
            return text.length > maxOutputBytes ? text.slice(0, maxOutputBytes) + `\n… truncated at ${maxOutputBytes} bytes` : text;
          },
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.allSettled(all.map(async (p) => (await p).client.close()));
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}
function normaliseSchema(s: Record<string, unknown>): Record<string, unknown> {
  const o = { ...s };
  if (o.type !== "object") o.type = "object";
  if (!o.properties) o.properties = {};
  delete o.$schema;
  return o;
}
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
