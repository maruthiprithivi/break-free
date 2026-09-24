/**
 * The job store the Stop hook reads at every turn end.
 *
 * list() read and JSON-parsed every record ever written - 299 files, 2.5 MB on a live machine,
 * 89% of it result text it then discarded - and nothing ever removed one. The cost of ending a
 * turn grew with the lifetime of the install.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRegistry } from "../dist/jobs.js";

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jobs-store-"));
const registry = (sessionDir) => new JobRegistry({ sessionDir, budget: {} }, false, "/repo/a");

test("a finished job's result is stored apart from its record, and still returned by get()", async () => {
  const sd = tmp();
  const r = registry(sd);
  const rec = r.start("delegate", "big answer", async () => ({ text: "x".repeat(50_000) }));
  await r.wait(rec.id, 5_000);
  await new Promise((res) => setTimeout(res, 50)); // persist runs in finally()

  const dir = path.join(sd, "jobs");
  const record = fs.readFileSync(path.join(dir, `${rec.id}.json`), "utf8");
  assert.ok(record.length < 2_000, `the record the hook reads is small: ${record.length} bytes`);
  assert.ok(fs.existsSync(path.join(dir, `${rec.id}.result.json`)), "the result lives beside it");
  assert.equal(registry(sd).get(rec.id).result.text.length, 50_000, "and a fresh process gets it back whole");
});

test("a record written before results moved out is split the first time it is listed, keeping its age", () => {
  const sd = tmp();
  const dir = path.join(sd, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "legacy-1.json");
  fs.writeFileSync(file, JSON.stringify({ id: "legacy-1", kind: "delegate", state: "done", workspace: "/repo/a", createdAt: new Date(Date.now() - 2 * DAY).toISOString(), progress: [], result: { text: "old answer" } }));
  const old = (Date.now() - 2 * DAY) / 1000;
  fs.utimesSync(file, old, old);

  assert.deepEqual(registry(sd).list().map((j) => j.id), ["legacy-1"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).result, undefined, "the record no longer carries the result");
  assert.equal(registry(sd).get("legacy-1").result.text, "old answer", "which is still reachable");
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - old * 1000) < 2_000, "and it did not become the newest record");
});

test("records past retention are removed, with their results", () => {
  const sd = tmp();
  const dir = path.join(sd, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, age] of [["fresh", 1], ["stale", 45]]) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: "delegate", state: "done", workspace: "/repo/a", createdAt: new Date(Date.now() - age * DAY).toISOString(), progress: [] }));
    fs.writeFileSync(path.join(dir, `${id}.result.json`), JSON.stringify({ text: id }));
    const t = (Date.now() - age * DAY) / 1000;
    fs.utimesSync(path.join(dir, `${id}.json`), t, t);
  }
  assert.deepEqual(registry(sd).list().map((j) => j.id), ["fresh"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["fresh.json", "fresh.result.json"], "the stale job left nothing behind");
});

test("a listing opens only the newest records, however many there are", () => {
  const sd = tmp();
  const dir = path.join(sd, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 400; i += 1) {
    const f = path.join(dir, `j${i}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: `j${i}`, kind: "delegate", state: "done", workspace: "/repo/a", createdAt: new Date(Date.now() - (400 - i) * 60_000).toISOString(), progress: [] }));
    const t = (Date.now() - (400 - i) * 60_000) / 1000;
    fs.utimesSync(f, t, t);
  }
  // A record that is not JSON would throw if opened. Placed among the oldest, it must never be.
  fs.writeFileSync(path.join(dir, "j0.json"), "not json - opened means scanned");
  const listed = registry(sd).list();
  assert.equal(listed.length, 100, "the listing still returns the newest hundred");
  assert.equal(listed[0].id, "j399");
});
