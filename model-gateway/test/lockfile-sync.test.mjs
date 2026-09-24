/**
 * The committed lockfile must say what package.json says.
 *
 * It said 3.7.0 for months while package.json moved to 4.5.3, and its root block never gained
 * zod-to-json-schema. `npm ci` - what CI runs - tolerates a stale root block, so CI stayed green.
 * The installer ran `npm install`, which rewrites it, so every real install was left dirty and
 * the next upstream lockfile change made every fast-forward update abort. This test is the CI
 * check that was missing: a release that bumps one and not the other now fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreBuildArtefacts } from "../dist/updates.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(here, "..", "package-lock.json"), "utf8"));

test("the lockfile's version is package.json's version", () => {
  assert.equal(lock.version, pkg.version, "bump package-lock.json with package.json on release");
  assert.equal(lock.packages[""].version, pkg.version);
});

test("the lockfile's root dependencies are package.json's dependencies", () => {
  assert.deepEqual(lock.packages[""].dependencies ?? {}, pkg.dependencies ?? {}, "regenerate with npm install --package-lock-only");
  assert.deepEqual(lock.packages[""].devDependencies ?? {}, pkg.devDependencies ?? {});
});

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artefact-"));
  fs.mkdirSync(path.join(root, "model-gateway"));
  fs.writeFileSync(path.join(root, "model-gateway", "package-lock.json"), '{"version":"1"}\n');
  fs.writeFileSync(path.join(root, "setup.mjs"), "// installer\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "one"]);
  return root;
}

test("a lockfile an install rewrote is put back so the next fast-forward can land", () => {
  const root = install();
  fs.writeFileSync(path.join(root, "model-gateway", "package-lock.json"), '{"version":"2"}\n');
  assert.equal(restoreBuildArtefacts(root), true);
  assert.equal(git(root, ["status", "--porcelain"]), "", "clean again");
});

test("anything a person changed is never touched, even alongside the lockfile", () => {
  const root = install();
  fs.writeFileSync(path.join(root, "model-gateway", "package-lock.json"), '{"version":"2"}\n');
  fs.writeFileSync(path.join(root, "setup.mjs"), "// a local fix someone made\n");
  assert.equal(restoreBuildArtefacts(root), false, "a checkout with real edits is left exactly as it is");
  assert.match(fs.readFileSync(path.join(root, "setup.mjs"), "utf8"), /local fix/);
  assert.match(fs.readFileSync(path.join(root, "model-gateway", "package-lock.json"), "utf8"), /"2"/, "not even the lockfile, when it is not alone");
});

test("a clean checkout is reported clean and left alone", () => {
  assert.equal(restoreBuildArtefacts(install()), true);
});
