/**
 * Asking tmux whether a sub-agent is still alive, from any gateway on the machine.
 *
 * A gateway started inside a Claude swarm teammate pane inherits TMUX pointing at the swarm's own
 * tmux server. A bare `tmux has-session` asked that server, which truthfully said "can't find
 * session", so live crewmates were recorded as exited and their sessions woken by a false
 * harness.exited - then an observer with the right server flipped them back. And a tmux that could
 * not be asked at all (not installed, timed out) was recorded the same way as a session that had
 * really gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessController } from "../dist/harnessctl.js";

const hasTmux = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

function controller(tmuxBin) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "hctl-"));
  const config = { sessionDir, workspaceRoot: sessionDir, harness: { tmux: tmuxBin ?? "tmux" } };
  return { sessionDir, hc: new HarnessController(config, false) };
}
function record(sessionDir, id, state, ageMs = 0) {
  const dir = path.join(sessionDir, "harness");
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, tmux: `bf-${id}`, harness: "sh", cwd: "/repo", createdAt: t, updatedAt: t, state }));
}

test("a tmux that cannot be asked leaves a running session running", async () => {
  // Not installed at this path: ENOENT. That is no answer, not "the sub-agent exited".
  const { sessionDir, hc } = controller("/nonexistent/tmux-binary");
  record(sessionDir, "alive1", "running");
  const [s] = await hc.list();
  assert.equal(s.state, "running", "no answer must not be recorded as an exit");
  assert.equal(await hc.status("alive1"), "unknown", "and status says it could not tell");
});

test("a session tmux confirms gone is recorded as exited", { skip: !hasTmux && "tmux not installed" }, async () => {
  const { sessionDir, hc } = controller();
  record(sessionDir, "gone1", "running");
  const [s] = await hc.list();
  assert.equal(s.state, "exited");
});

test("an inherited TMUX pointing at another server does not make live sessions look dead", { skip: !hasTmux && "tmux not installed" }, async () => {
  const { sessionDir, hc } = controller();
  const live = await hc.spawn("sh", { cwd: sessionDir, command: "sleep 30" });
  const saved = process.env.TMUX;
  // What a gateway in a swarm teammate pane inherits: some other tmux server's socket.
  process.env.TMUX = "/tmp/tmux-nonexistent/claude-swarm-1,1,0";
  try {
    const s = (await hc.list()).find((x) => x.id === live.id);
    assert.equal(s.state, "running", "asked the default server, where the session lives - not the swarm's");
  } finally {
    if (saved === undefined) delete process.env.TMUX; else process.env.TMUX = saved;
    await hc.close(live.id);
  }
});

test("an exited record is retired once tmux has confirmed it gone for a day", { skip: !hasTmux && "tmux not installed" }, async () => {
  const { sessionDir, hc } = controller();
  record(sessionDir, "old", "exited", 2 * 24 * 60 * 60 * 1000);
  record(sessionDir, "recent", "exited", 60 * 1000);
  const ids = (await hc.list()).map((s) => s.id).sort();
  assert.deepEqual(ids, ["recent"], "a day-old confirmed exit is dropped; a recent one is still listed");
  assert.equal(fs.existsSync(path.join(sessionDir, "harness", "old.json")), false);
});

test("a tmux that runs but speaks another protocol is no answer, not an exit", async () => {
  // A client and server from different tmux versions: tmux runs, fails, and says why. Reading
  // that as "the session is gone" would record a live crewmate as exited.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faketmux-"));
  const bin = path.join(dir, "tmux");
  fs.writeFileSync(bin, "#!/bin/sh\necho 'protocol version mismatch (client 8, server 7)' >&2\nexit 1\n", { mode: 0o755 });
  const { sessionDir, hc } = controller(bin);
  record(sessionDir, "alive2", "running");
  const [s] = await hc.list();
  assert.equal(s.state, "running");
});

test("a tmux that answers with a bare exit code has answered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faketmux-"));
  const bin = path.join(dir, "tmux");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { sessionDir, hc } = controller(bin);
  record(sessionDir, "gone2", "running");
  const [s] = await hc.list();
  assert.equal(s.state, "exited");
});
