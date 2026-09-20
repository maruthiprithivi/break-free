/**
 * The knowledge layer: finding an Obsidian vault and surfacing the ledger in it.
 *
 * Offline and deterministic — a fake vault, a fake registry and a fake ledger on disk, no
 * Obsidian required. The cases that matter are the refusals: a machine with no Obsidian must
 * stay silent, and a vault holding someone's notes must never lose them to this.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryPath, registryVaults, resolveVault, linkLedger } from "../dist/knowledge.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"));
const cfg = (o = {}) => ({ obsidian: { mode: "link", folder: "break-free", ...o } });

/** A fake home with Obsidian's registry in the platform's real location. */
function fakeHome(vaults) {
  const home = tmp();
  const reg = registryPath(home, "darwin");
  fs.mkdirSync(path.dirname(reg), { recursive: true });
  fs.writeFileSync(reg, JSON.stringify({ vaults: Object.fromEntries(vaults.map((v, i) => [`id${i}`, v])) }));
  return home;
}

function fakeLedger() {
  const dir = path.join(tmp(), ".break-free");
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# Plan\n");
  return dir;
}

test("no Obsidian at all is silence, not an error", () => {
  const home = tmp(); // no registry written
  assert.deepEqual(registryVaults(home, "darwin"), [], "a machine without Obsidian has no vaults and no complaint");
  // A registry that exists but is corrupt is the same story: optional means optional.
  const reg = registryPath(home, "darwin");
  fs.mkdirSync(path.dirname(reg), { recursive: true });
  fs.writeFileSync(reg, "{not json");
  assert.deepEqual(registryVaults(home, "darwin"), []);
});

test("the registry is read, and a vault that no longer exists on disk is not offered", () => {
  const real = tmp();
  const home = fakeHome([{ path: real, open: false }, { path: path.join(real, "deleted-vault"), open: true }]);
  const found = registryVaults(home, "darwin");
  assert.deepEqual(found.map((v) => v.path), [real], "a registry entry pointing at a deleted folder is not a vault");
  assert.equal(found[0].source, "registry");
});

test("an explicit vault wins over the environment, and mode off resolves to nothing", () => {
  const explicit = tmp();
  assert.equal(resolveVault(cfg({ vault: explicit }), { OBSIDIAN_VAULT: tmp() }).path, explicit);
  assert.equal(resolveVault(cfg({ vault: explicit }), {}).source, "config");
  // A configured path that does not exist is not silently swapped for something else.
  assert.equal(resolveVault(cfg({ vault: path.join(explicit, "nope") }), {}), undefined);
  // $OBSIDIAN_VAULT is used when nothing is configured.
  const fromEnv = tmp();
  assert.equal(resolveVault(cfg(), { OBSIDIAN_VAULT: fromEnv }).source, "env");
  // off means off, whatever is configured or detected.
  assert.equal(resolveVault(cfg({ vault: explicit, mode: "off" }), {}), undefined);
});

test("link symlinks the ledger rather than copying it, and is idempotent", () => {
  const vault = tmp(), ledger = fakeLedger();
  const r = linkLedger(vault, "myproj", ledger, cfg());
  assert.equal(r.action, "linked");
  const target = path.join(vault, "break-free", "myproj");
  assert.equal(r.target, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), "it must be a link, so the repository stays the source of truth");
  assert.ok(fs.existsSync(path.join(target, "PLAN.md")), "the ledger is readable through the link");

  // A note written in the vault is the same bytes the repository sees.
  fs.writeFileSync(path.join(target, "notes", "from-vault.md"), "written in obsidian\n");
  assert.equal(fs.readFileSync(path.join(ledger, "notes", "from-vault.md"), "utf8"), "written in obsidian\n");

  assert.equal(linkLedger(vault, "myproj", ledger, cfg()).action, "already-linked", "running it twice must not fail or duplicate");
});

test("someone else's notes are never overwritten", () => {
  const vault = tmp(), ledger = fakeLedger();
  const dir = path.join(vault, "break-free");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "myproj");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "important.md"), "a year of my notes\n");

  const r = linkLedger(vault, "myproj", ledger, cfg());
  assert.equal(r.action, "skipped");
  assert.match(r.reason, /already exists and is not our link/);
  assert.equal(fs.readFileSync(path.join(target, "important.md"), "utf8"), "a year of my notes\n", "the vault is someone's notes; losing them to this would be far worse than a skipped step");

  // A symlink pointing at a DIFFERENT ledger is also left alone, not repointed.
  const other = fakeLedger();
  const target2 = path.join(dir, "other");
  fs.symlinkSync(other, target2, "dir");
  assert.equal(linkLedger(vault, "other", ledger, cfg()).action, "skipped");
  assert.equal(path.resolve(fs.readlinkSync(target2)), path.resolve(other));
});

test("index writes a note instead of a link, and off does nothing", () => {
  const vault = tmp(), ledger = fakeLedger();
  const r = linkLedger(vault, "myproj", ledger, cfg({ mode: "index" }));
  assert.equal(r.action, "indexed");
  const body = fs.readFileSync(r.target, "utf8");
  assert.match(body, /tags: \[break-free\]/);
  assert.ok(body.includes(ledger), "the note has to say where the ledger actually is");
  assert.ok(!fs.existsSync(path.join(vault, "break-free", "myproj")), "index mode must not also link");

  assert.equal(linkLedger(vault, "myproj", ledger, cfg({ mode: "off" })).action, "skipped");
});

test("a project with no ledger yet is skipped, not half-linked", () => {
  const vault = tmp();
  const r = linkLedger(vault, "myproj", path.join(tmp(), ".break-free"), cfg());
  assert.equal(r.action, "skipped");
  assert.match(r.reason, /no ledger at/);
  assert.ok(!fs.existsSync(path.join(vault, "break-free", "myproj")), "nothing is created for a project that has no ledger");
});
