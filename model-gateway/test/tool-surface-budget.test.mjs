/**
 * What every turn of every session pays for break-free's tools, held to a number.
 *
 * The advertised tool schemas are re-sent on every turn whether or not anything is called, and
 * 53% of their bytes were prose. Of that, 2,094 bytes were the same six field descriptions sent
 * three times - delegate, supervise and run_plan's per-task schema. A saving nobody measures drifts
 * back, so this measures it: no description may appear twice, and the surface has a budget that
 * only ratchets down.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");
/** Bytes of the compact surface. Lower it when you save more; raising it needs a reason. */
const BUDGET_BYTES = 16_000;

let tmp, tools;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
  const ws = path.join(tmp, "repo");
  fs.mkdirSync(ws);
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ sessionDir: path.join(tmp, "s"), logFile: false, context: { toolProfile: "compact" }, providers: {} }));
  const c = new Client({ name: "surface", version: "1" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", cfg] }));
  tools = (await c.listTools()).tools;
  await c.close();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function descriptions() {
  const out = [];
  const walk = (o, where) => {
    if (!o || typeof o !== "object") return;
    if (typeof o.description === "string") out.push({ where, text: o.description });
    for (const [k, v] of Object.entries(o)) if (k !== "description") walk(v, `${where}.${k}`);
  };
  for (const t of tools) {
    if (t.description) out.push({ where: `${t.name}`, text: t.description });
    walk(t.inputSchema, t.name);
  }
  return out;
}

test("no description is sent twice", () => {
  const seen = new Map();
  for (const d of descriptions()) {
    // Short labels ("Alias/provider/model") may legitimately recur; paragraphs may not.
    if (d.text.length < 60) continue;
    assert.ok(!seen.has(d.text), `sent twice every turn - ${seen.get(d.text)} and ${d.where}:\n  "${d.text.slice(0, 100)}..."`);
    seen.set(d.text, d.where);
  }
});

test("the always-sent tool surface stays within its budget", () => {
  const bytes = tools.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t)), 0);
  console.log(`compact surface: ${tools.length} tools, ${bytes} bytes, ~${Math.ceil(bytes / 3)} tokens per turn`);
  assert.ok(bytes <= BUDGET_BYTES, `${bytes} bytes against a budget of ${BUDGET_BYTES}: every byte here is paid on every turn of every session`);
});

test("every field that points at delegate points at a field delegate actually has", () => {
  const delegate = tools.find((t) => t.name === "delegate");
  const props = new Set(Object.keys(delegate.inputSchema.properties));
  for (const d of descriptions()) {
    const m = d.text.match(/^As delegate\.(\w+)\.$/);
    if (m) assert.ok(props.has(m[1]), `${d.where} points at delegate.${m[1]}, which delegate does not have`);
  }
});
