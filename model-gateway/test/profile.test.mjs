/**
 * The compact tool profile: what break-free advertises permanently, and how the rest is reached.
 *
 * The tool surface is sent to the lead in every session and re-sent every turn, so an
 * advertised tool is a standing cost whether or not anyone calls it. Compact keeps execution
 * and its lifecycle typed and resident and moves the rest behind discovery.
 *
 * The property that makes this acceptable — and that separates it from simply not registering
 * a tool — is that NOTHING becomes unreachable. These tests exist to keep that true.
 */
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

let mock, tmp;

async function gateway(toolProfile) {
  const dir = fs.mkdtempSync(path.join(tmp, "gw-"));
  const ws = path.join(dir, "repo");
  fs.mkdirSync(ws, { recursive: true });
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({
    sessionDir: path.join(dir, "sessions"),
    logFile: false,
    context: { toolProfile },
    defaults: { model: "mock/good" },
    providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" } },
  }));
  const client = new Client({ name: "profile-test", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", cfg] }));
  return client;
}

const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
const callText = async (c, name, args) => (await c.callTool({ name, arguments: args })).content.map((x) => x.text).join("\n");

before(async () => {
  mock = await startMockProvider();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
});
after(async () => {
  await mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("compact advertises far fewer tools than full, and full still advertises everything", async () => {
  const [compact, full] = [await gateway("compact"), await gateway("full")];
  try {
    const c = await names(compact), f = await names(full);
    assert.ok(c.length < f.length / 2, `compact should be well under half of full: ${c.length} vs ${f.length}`);
    // Every compact tool is a real tool, not an invention of the profile.
    for (const n of c) if (!n.startsWith("bf_")) assert.ok(f.includes(n), `${n} is advertised by compact but does not exist in full`);
  } finally {
    await compact.close(); await full.close();
  }
});

test("execution keeps its lifecycle: starting work you cannot stop is not an option", async () => {
  const c = await gateway("compact");
  try {
    const n = await names(c);
    // Advertising delegate while hiding job_cancel would leave an agent able to start work it
    // has no typed way to stop.
    for (const must of ["delegate", "run_plan", "job_status", "job_result", "job_cancel", "ledger_resume", "bf_discover", "bf_invoke"]) {
      assert.ok(n.includes(must), `${must} must stay resident under compact`);
    }
  } finally { await c.close(); }
});

test("a hidden operation is discoverable and callable, never unreachable", async () => {
  const c = await gateway("compact");
  try {
    assert.ok(!(await names(c)).includes("worktree_list"), "worktree_list is not advertised under compact");

    const list = JSON.parse(await callText(c, "bf_discover", {}));
    assert.ok(list.count > 20, `expected many hidden operations, got ${list.count}`);
    assert.ok(list.operations.some((o) => o.operation === "worktree_list"), "and it is listed");

    // Its schema is available on demand, which is the whole bargain.
    const schema = JSON.parse(await callText(c, "bf_discover", { operation: "worktree_list" }));
    assert.equal(schema.operation, "worktree_list");
    assert.ok(schema.input_schema, "a caller has to be able to learn how to call it");

    // And it actually runs.
    const out = await callText(c, "bf_invoke", { operation: "worktree_list", arguments: {} });
    assert.ok(out.length > 0);
    assert.doesNotMatch(out, /no operation/);

    // The filter matches names AND titles, so it narrows without every name containing the word.
    const filtered = JSON.parse(await callText(c, "bf_discover", { match: "worktree" }));
    assert.ok(filtered.count > 0 && filtered.count < list.count, `filter should narrow: ${filtered.count} of ${list.count}`);
    assert.ok(filtered.operations.some((o) => o.operation.startsWith("worktree_")));
  } finally { await c.close(); }
});

test("dispatch validates arguments the same way an advertised tool would", async () => {
  const c = await gateway("compact");
  try {
    // Skipping validation would make the compact profile a hole rather than a saving.
    const bad = await c.callTool({ name: "bf_invoke", arguments: { operation: "worktree_update", arguments: { status: "not-a-real-status" } } });
    assert.equal(bad.isError, true, "an invalid argument must fail here exactly as it would there");

    const missing = await c.callTool({ name: "bf_invoke", arguments: { operation: "no_such_operation", arguments: {} } });
    assert.equal(missing.isError, true);
    assert.match(missing.content.map((x) => x.text).join(""), /no operation/);
  } finally { await c.close(); }
});

test("an argument the operation does not have is refused by name, never dropped", async () => {
  // The call from a live session: interrupt a sub-agent with harness_send {id, keys:[...]} through
  // bf_invoke. `keys` did not exist, was stripped without a word, an empty line was sent instead,
  // and sent:true came back - so the lead reported an interrupt that never happened.
  const c = await gateway("compact");
  try {
    const r = await c.callTool({ name: "bf_invoke", arguments: { operation: "worktree_list", arguments: { markdown: false, colour: "blue" } } });
    assert.equal(r.isError, true, "an unknown argument must fail");
    const msg = r.content.map((x) => x.text).join("");
    assert.match(msg, /worktree_list has no argument "colour"/, "and say which one");
    assert.match(msg, /accepts: markdown/, "and what it does accept");
    assert.doesNotMatch(msg, /"code":\s*"/, "in words, not a raw validation dump");
  } finally { await c.close(); }
});

test("a wrong type is explained by field, not dumped", async () => {
  const c = await gateway("compact");
  try {
    const r = await c.callTool({ name: "bf_invoke", arguments: { operation: "worktree_list", arguments: { markdown: "yes" } } });
    assert.equal(r.isError, true);
    const msg = r.content.map((x) => x.text).join("");
    assert.match(msg, /^ERROR: markdown: /, "the field comes first");
    assert.doesNotMatch(msg, /"code":\s*"/);
  } finally { await c.close(); }
});
