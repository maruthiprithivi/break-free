import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIRSTMATE_DEPRECATION } from "../dist/firstmate.js";
import { loadConfig } from "../dist/config.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

test("bf firstmate prints the migration notice and exits 2", () => {
  const result = spawnSync(process.execPath, [cli, "firstmate"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Firstmate is the entry point; start your home directly/);
  assert.doesNotMatch(result.stderr, /profiles/);
  assert.equal(result.stderr.trim(), FIRSTMATE_DEPRECATION);
});

test("bf firstmate accepts legacy launch flags and still prints the migration notice", () => {
  const args = [cli, "firstmate", "--harness", "claude", "--task", "x", "--fm-home", "/tmp/fm", "--dry-run", "--json"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), FIRSTMATE_DEPRECATION);
});

test("legacy Firstmate config keys still load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-fm-config-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ firstmate: { enabled: true, root: "/unused", pin: "abc", harness: "claude" } }));
  const config = loadConfig({ configPath: file }).config;
  assert.equal(config.firstmate.root, "/unused");
  assert.equal(config.firstmate.pin, "abc");
});
