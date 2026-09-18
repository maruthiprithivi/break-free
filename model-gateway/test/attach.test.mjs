// End-to-end tests: spawn the real MCP server over stdio against a mock provider,
// with a fake tmux binary, and verify the harness `attach` command is exposed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockProvider } from "./mock-provider.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

let mock, client, tmp, ws, configPath, tmuxBin;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { text, isError: !!r.isError, json: () => JSON.parse(text) };
};

before(async () => {
  mock = await startMockProvider();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-attach-test-"));
  ws = path.join(tmp, "repo");
  fs.mkdirSync(ws, { recursive: true });
  ws = fs.realpathSync(ws); // macOS: /var -> /private/var; the gateway realpaths its workspace root, so match it

  // Mock tmux: sessions are files under tmux-state; the harness tests only need
  // new-session, has-session and kill-session, but keep the same shape as gateway.test.mjs.
  const tmuxState = path.join(tmp, "tmux-state");
  fs.mkdirSync(tmuxState, { recursive: true });
  tmuxBin = path.join(tmp, "tmux");
  fs.writeFileSync(tmuxBin, [
    "#!/usr/bin/env bash",
    `STATE="${tmuxState}"`,
    'mkdir -p "$STATE"',
    'cmd="$1"; shift',
    'arg() { local f="$1" prev=""; shift; for a in "$@"; do [ "$prev" = "$f" ] && { printf "%s" "$a"; return 0; }; prev="$a"; done; }',
    'case "$cmd" in',
    '  new-session) : > "$STATE/$(arg -s "$@")"; exit 0 ;;',
    '  send-keys) t="$(arg -t "$@")"; lit="$(arg -l "$@")"; [ -n "$lit" ] && printf "%s" "$lit" >> "$STATE/$t"; case " $* " in *" Enter "*) echo >> "$STATE/$t" ;; esac; exit 0 ;;',
    '  capture-pane) cat "$STATE/$(arg -t "$@")" 2>/dev/null; exit 0 ;;',
    '  has-session) [ -f "$STATE/$(arg -t "$@")" ] && exit 0 || exit 1 ;;',
    '  kill-session) rm -f "$STATE/$(arg -t "$@")"; exit 0 ;;',
    '  *) exit 0 ;;',
    "esac",
    "",
  ].join("\n"));
  fs.chmodSync(tmuxBin, 0o755);

  configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sessionDir: path.join(tmp, "sessions"),
    harness: { tmux: tmuxBin },
    logFile: path.join(tmp, "gateway.log"),
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" },
    },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--workspace", ws, "--config", configPath],
    env: { ...process.env, BREAK_FREE_TMUX: "" },
    stderr: "pipe",
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await mock?.close();
});

test("harness_spawn, harness_status and harness_list expose the tmux attach command", async () => {
  const sp = (await call("harness_spawn", { harness: "claude" })).json();
  assert.ok(sp.id);
  assert.ok(sp.tmux.startsWith("bf-"));
  assert.equal(sp.attach, `${tmuxBin} attach -t ${sp.tmux}`);
  assert.ok(sp.attach.includes(sp.tmux), "attach must contain the tmux session name");
  assert.ok(sp.attach.includes(tmuxBin), "attach must contain the configured tmux binary");

  const st = (await call("harness_status", { id: sp.id })).json();
  assert.equal(st.state, "running");
  assert.equal(st.attach, sp.attach);

  const list = (await call("harness_list")).json();
  const row = list.sessions.find((x) => x.id === sp.id);
  assert.ok(row, "harness_list must include the spawned session");
  assert.equal(row.attach, sp.attach, "harness_list row must carry the same attach field");

  assert.equal((await call("harness_close", { id: sp.id })).json().closed, true);
});
