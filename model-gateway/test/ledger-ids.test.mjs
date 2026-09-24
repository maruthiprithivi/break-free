/**
 * Two gateways on one checkout must never mint the same task id.
 *
 * nextId() is "highest existing plus one", and createTask used to check that the file was free
 * and then overwrite it. A run_plan and a task_create a millisecond apart both chose T-037, both
 * saw it free, and the second write silently replaced the first task - no error, one task gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../dist/ledger.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const ledgerModule = path.join(here, "..", "dist", "ledger.js");

test("eight processes creating tasks at the same moment all keep their task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bf-ids-"));
  new Ledger(root).createTask({ title: "seed" }); // so every racer computes the same next id

  // Separate processes, released together: the real shape - several gateways, one checkout.
  const go = Date.now() + 400;
  const script = (i) => `
    import(${JSON.stringify(ledgerModule)}).then(({ Ledger }) => {
      const wait = ${go} - Date.now(); const t0 = Date.now(); while (Date.now() - t0 < wait) {}
      new Ledger(${JSON.stringify(root)}).createTask({ title: "racer-${i}" });
    });`;
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script(i)], (e, _o, err) => (e ? reject(new Error(err || e.message)) : resolve())))));

  const tasks = new Ledger(root).listTasks();
  const titles = tasks.map((t) => t.title).filter((t) => t.startsWith("racer-")).sort();
  assert.deepEqual(titles, Array.from({ length: 8 }, (_, i) => `racer-${i}`).sort(), "no task was overwritten by another");
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length, "and every id is distinct");
  assert.deepEqual(fs.readdirSync(path.join(root, ".break-free", "tasks")).filter((f) => f.includes(".tmp")), [], "no claim debris left behind");
});

test("an explicit id that is taken is refused, never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bf-ids-"));
  const l = new Ledger(root);
  l.createTask({ id: "T-900", title: "first" });
  assert.throws(() => l.createTask({ id: "T-900", title: "second" }), /already exists/);
  assert.equal(l.getTask("T-900").title, "first");
});
