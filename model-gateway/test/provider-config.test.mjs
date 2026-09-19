// Issue #13, second half: "unconfigurable without hand-editing". Two things were impossible through
// the documented `configure_*` route — adding a local OpenAI-compatible endpoint without a key it
// does not want, and (first half, already fixed) reading a reasoning model's probe honestly. These
// tests drive the real MCP server over stdio, and a restart is the only reload that proves the
// setting was persisted rather than held in memory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROVIDER_CATALOG, isLocalEndpoint } from "../dist/providers.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

/** Local-server shapes: what `configure_provider` should recognise without being told. */
const LOCAL = "http://127.0.0.1:11435/v1";
const LAN = "http://10.0.0.5:8000/v1";
/** A public endpoint must not inherit the keyless default, however tempting it is to blanket-apply. */
const PUBLIC = "https://api.example.com/v1";

let reasoning; // reasoning-only provider, started with the suite

before(async () => {
  reasoning = await startReasoningProvider();
});

after(async () => {
  await reasoning?.close();
});

/**
 * A provider shaped like a local reasoning model on Ollama's OpenAI-compatible endpoint: the visible
 * answer is empty and the whole output sits in a `reasoning` field. `starved` reports that it ran out
 * of budget instead, which is the case that used to be reported as "tools may be unsupported".
 */
function startReasoningProvider() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url.endsWith("/models")) return send({ data: [{ id: "quiet" }, { id: "starved" }] });
      const j = JSON.parse(body);
      const starved = j.model === "starved";
      const usage = { prompt_tokens: 5, completion_tokens: 16, total_tokens: 21 };
      if (j.tools?.length && !starved) {
        return send({
          id: "c1",
          choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: '{"n":1}' } }] } }],
          usage,
        });
      }
      send({ id: "c1", choices: [{ index: 0, finish_reason: starved ? "length" : "stop", message: { role: "assistant", content: "", reasoning: "x".repeat(274) } }], usage });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

async function startGateway(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-provider-"));
  let ws = path.join(tmp, "repo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  ws = fs.realpathSync(ws);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: ws });
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sessionDir: path.join(tmp, "sessions"),
    logFile: path.join(tmp, "gateway.log"),
    defaults: { model: "fast", timeoutMs: 8000, maxToolIterations: 1 },
    fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
    providers: { reasonmock: { baseUrl: `http://127.0.0.1:${reasoning.port}/v1`, apiKey: "ignored", defaultModel: "quiet" } },
    ...over,
  }));
  return startGatewayAt({ configPath, ws });
}

/** A second process on the same config + workspace: the reload that matters. */
async function startGatewayAt({ configPath, ws }) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath], env: { ...process.env }, stderr: "pipe" }));
  return {
    ws,
    configPath,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.map((c) => c.text).join("\n");
      return { text, isError: !!r.isError, json: () => JSON.parse(text) };
    },
    saved: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
    close: () => client.close(),
  };
}

test("a keyless local endpoint can be added in one call, and survives a restart", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const r = (await g.call("configure_provider", { provider: "optimus", base_url: LOCAL })).json();
  assert.equal(r.provider.usable, true, "one call, no hand-editing, no placeholder key");
  assert.equal(r.provider.requires_key, false);
  assert.equal(r.provider.api_key, "(not required)");
  assert.equal(g.saved().providers.optimus.requiresKey, false, "the decision is persisted, not in-memory");

  // A restart reads the file back: this is the "survives a config reload" criterion.
  const g2 = await startGatewayAt(g);
  t.after(g2.close);
  const listed = (await g2.call("list_providers")).json().providers.find((p) => p.provider === "optimus");
  assert.equal(listed.usable, true);
  assert.equal(listed.requires_key, false);
});

test("the keyless default covers private addresses, and a public URL keeps requiring a key", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const lan = (await g.call("configure_provider", { provider: "lan-vllm", base_url: LAN })).json();
  assert.equal(lan.provider.usable, true);
  assert.equal(lan.provider.requires_key, false);

  const remote = (await g.call("configure_provider", { provider: "remote-x", base_url: PUBLIC })).json();
  assert.equal(remote.provider.usable, false);
  assert.match(remote.provider.reason, /no API key/);
  assert.equal(remote.provider.requires_key, true, "a public endpoint is not presumed keyless");
  assert.ok(!/looks local/.test(remote.provider.reason), "and it is not given the local advice");
});

test("a hand-added local provider is told the one-call fix, not just that a key is missing", async (t) => {
  // The provider that was added without `requiresKey` (the state #13 found users in) must point at
  // the documented route out, since "set OPTIMUS_API_KEY" would be advice to lie about a key.
  const g = await startGateway({ providers: { "hand-local": { baseUrl: LAN } } });
  t.after(g.close);
  const listed = (await g.call("list_providers")).json().providers.find((p) => p.provider === "hand-local");
  assert.equal(listed.usable, false);
  assert.match(listed.reason, /no API key/);
  assert.match(listed.reason, /looks local/);
  assert.match(listed.reason, /configure_provider \{provider:"hand-local", requires_key:false\}/);
  // Following that advice is enough — no key, no hand-editing.
  const fixed = (await g.call("configure_provider", { provider: "hand-local", requires_key: false })).json();
  assert.equal(fixed.provider.usable, true);
  assert.equal(g.saved().providers["hand-local"].requiresKey, false);
});

test("an explicit key, key_env or requires_key wins over the local default", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  // A key means auth on purpose — even at a loopback address.
  const keyed = (await g.call("configure_provider", { provider: "keyed-local", base_url: LOCAL, api_key: "sk-literal" })).json();
  assert.equal(keyed.provider.requires_key, true);
  assert.equal(keyed.provider.usable, true);

  const env = (await g.call("configure_provider", { provider: "env-local", base_url: LOCAL, key_env: "ENV_LOCAL_KEY_UNSET" })).json();
  assert.equal(env.provider.requires_key, true, "key_env is a request for auth, so the local default does not apply");
  assert.equal(env.provider.usable, false, "and an unset env var is still a missing key");
  assert.match(env.provider.reason, /ENV_LOCAL_KEY_UNSET/);

  const forced = (await g.call("configure_provider", { provider: "forced-local", base_url: LOCAL, requires_key: true })).json();
  assert.equal(forced.provider.requires_key, true);
  assert.equal(forced.provider.usable, false);
});

test("project scope cannot set requires_key, exactly as it cannot set a key", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  // base_url is refused at project scope for the same reason (a keyless endpoint is an endpoint),
  // so the call must be refused outright and leave no project config behind.
  const r = await g.call("configure_provider", { provider: "optimus", base_url: LOCAL, requires_key: false, scope: "project" });
  assert.ok(r.isError);
  assert.match(r.text, /requiresKey/);
  assert.match(r.text, /cannot set/);
  assert.equal(fs.existsSync(path.join(g.ws, ".model-gateway.json")), false, "nothing was written");
});

test("test_provider explains an empty reply instead of blaming the tools", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  // The reasoning model: tools actually work, and the empty `reply` says why it is empty.
  const ok = (await g.call("test_provider", { spec: "reasonmock/quiet" })).json().results[0];
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, "");
  assert.equal(ok.reasoning_chars, 274);
  assert.match(ok.note, /274 chars of reasoning and no visible reply/);
  assert.equal(ok.tool_calling, "ok", "the probe gives a reasoning preamble room, so tools are not blamed");

  // The starved model: the budget ran out, and the report says THAT rather than "tools may be unsupported".
  const starved = (await g.call("test_provider", { spec: "reasonmock/starved" })).json().results[0];
  assert.equal(starved.reply, "");
  assert.match(starved.note, /budget was spent before any visible reply/);
  assert.match(starved.tool_calling, /token budget ran out first/);
  assert.ok(!/tools may be unsupported/.test(starved.tool_calling));
});

test("isLocalEndpoint recognises local servers and never a public name", () => {
  // The seam the default rests on: a public FQDN must never be treated as local, or a cloud endpoint
  // would silently be configured as keyless.
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11435/v1", "http://127.9.9.9:1/v1", "http://10.1.2.3:8000/v1", "http://172.16.0.1:8000/v1", "http://192.168.0.9:11434/v1", "http://169.254.1.1/v1", "http://100.101.102.103:8000/v1", "http://optimus:11435/v1", "http://[::1]:11435/v1", "http://box.local:8080/v1"]) {
    assert.equal(isLocalEndpoint(url), true, url);
  }
  for (const url of ["https://api.deepseek.com/v1", "https://ollama.com/v1", "https://api.example.com/v1", "http://172.32.0.1:8000/v1", "http://11.0.0.1:8000/v1", "not-a-url"]) {
    assert.equal(isLocalEndpoint(url), false, url);
  }
  // Every shipped catalog entry keeps its declared answer: the default is for new endpoints, not a
  // retroactive edit of the ones the catalog already describes.
  assert.equal(PROVIDER_CATALOG.ollama.requiresKey, false);
  assert.equal(PROVIDER_CATALOG.deepseek.requiresKey, true);
  assert.equal(isLocalEndpoint(PROVIDER_CATALOG.deepseek.baseUrl), false);
});
