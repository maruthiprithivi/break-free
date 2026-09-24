/**
 * The glob a worker passes to list_files and search, and the one a worktree claims.
 *
 * Both had a private copy of the matcher, built by chained replacements, whose last pass rewrote
 * the star inside the group the first pass produced - so `**` followed by a slash meant "at most one
 * directory". A worker asking list_files for every .ts file got only the top-level ones, and a
 * claim on src/**\/*.ts missed every file below its first directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { Workspace } from "../dist/workspace.js";

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "globs-")));
  for (const f of ["top.ts", "src/one.ts", "src/deep/two.ts", "src/deep/er/three.ts", "src/readme.md", ".env.local"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "export const x = 1;\n");
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "one"]);
  const config = loadConfig({ workspaceRoot: root, configPath: path.join(root, "none.json") }).config;
  return { root, ws: new Workspace(config, root) };
}
const tool = (ws, name) => ws.tools().find((t) => t.spec.function.name === name);

test("a double-star glob reaches every depth, not just the first directory", async () => {
  const { ws } = repo();
  const out = await tool(ws, "list_files").run({ path: ".", pattern: "**/*.ts" });
  for (const f of ["src/one.ts", "src/deep/two.ts", "src/deep/er/three.ts"]) assert.match(out, new RegExp(f.replace(/\./g, "\\.")), `${f} must be found`);
  assert.doesNotMatch(out, /readme\.md/);
});

test("a directory-scoped glob stays inside its directory", async () => {
  const { ws } = repo();
  const out = await tool(ws, "list_files").run({ path: ".", pattern: "src/deep/**/*.ts" });
  assert.match(out, /src\/deep\/two\.ts/);
  assert.match(out, /src\/deep\/er\/three\.ts/);
  assert.doesNotMatch(out, /src\/one\.ts/);
  assert.doesNotMatch(out, /top\.ts/);
});

test("a bare word is still a substring filter", async () => {
  const { ws } = repo();
  const out = await tool(ws, "list_files").run({ path: ".", pattern: "deep" });
  assert.match(out, /src\/deep\/two\.ts/);
  assert.match(out, /src\/deep\/er\/three\.ts/);
});

test("the jail still denies secrets, whatever the glob fix did", async () => {
  const { ws } = repo();
  // .env.local must stay unreadable: the deny list was deliberately left out of the new matcher.
  await assert.rejects(() => tool(ws, "read_file").run({ path: ".env.local" }), /denied|not allowed|refus/i);
});
