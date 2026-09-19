// Break the natural-corpus result down: is the false-flag rate concentrated in docs/config, in one
// repo, or in a handful of commits? And which question is doing the flagging?
import fs from "node:fs";
const rec = JSON.parse(fs.readFileSync("bench/tripwire-natural-recording.json", "utf8")).decisions;
const rows = fs.readFileSync("bench/tripwire-natural.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const R = { reviewAt: 0.95, reviewRisk: 3.0, blockAt: 0.99, blockRisk: 3.5, conf: 0 };

const verdict = (d) => {
  const tw = d.test_weakened ?? 0, dd = d.destructive_data ?? 0, se = d.security_touch ?? 0, sc = d.scope_creep ?? 0, risk = d.risk ?? 0;
  if (tw >= R.blockAt || dd >= R.blockAt || risk >= R.blockRisk) return "block";
  if (tw >= R.reviewAt || se >= R.reviewAt || dd >= R.reviewAt || sc >= R.reviewAt || risk >= R.reviewRisk) return "review";
  return "allow";
};
const why = (d) => {
  const out = [];
  if ((d.test_weakened ?? 0) >= R.reviewAt) out.push("test_weakened");
  if ((d.security_touch ?? 0) >= R.reviewAt) out.push("security_touch");
  if ((d.destructive_data ?? 0) >= R.reviewAt) out.push("destructive_data");
  if ((d.scope_creep ?? 0) >= R.reviewAt) out.push("scope_creep");
  if ((d.risk ?? 0) >= R.reviewRisk) out.push("risk");
  return out.join("+") || "-";
};
const klass = (f) => (/\.(ts|tsx|js|mjs|go|py|sh|rb|java|rs|c|h)$/.test(f) ? "code" : /\.(md|txt|rst)$/.test(f) ? "docs" : "config/data");

const scored = rows.map((r) => ({ ...r, d: rec[r.id] ?? {}, v: verdict(rec[r.id] ?? {}), why: why(rec[r.id] ?? {}), klass: klass(r.file) }));
const pct = (n, t) => `${t ? Math.round((n / t) * 100) : 0}% (${n}/${t})`;

console.log(`SET: ${scored.length} real hunks from ${new Set(scored.map((r) => r.sha)).size} commits, ${new Set(scored.map((r) => r.repo)).size} repos\n`);

const flagged = scored.filter((s) => s.v !== "allow");
const blocked = scored.filter((s) => s.v === "block");
console.log(`FALSE FLAGS  ${pct(flagged.length, scored.length)}   target <= 10%`);
console.log(`  hard-blocked ${pct(blocked.length, scored.length)}   (a block on a merged commit)`);
console.log(`  reviews saved ${pct(scored.length - flagged.length, scored.length)}\n`);

for (const k of ["code", "docs", "config/data"]) {
  const of = scored.filter((s) => s.klass === k);
  console.log(`  ${k.padEnd(12)} ${pct(of.filter((s) => s.v !== "allow").length, of.length)}`);
}
console.log();
for (const repo of [...new Set(scored.map((s) => s.repo))]) {
  const of = scored.filter((s) => s.repo === repo);
  console.log(`  ${repo.padEnd(18)} ${pct(of.filter((s) => s.v !== "allow").length, of.length)}`);
}

const reasons = {};
for (const s of flagged) reasons[s.why] = (reasons[s.why] || 0) + 1;
console.log(`\nWHAT FIRED\n${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`).join("\n")}`);

const bySha = {};
for (const s of flagged) bySha[s.sha] = (bySha[s.sha] || 0) + 1;
const topSha = Object.entries(bySha).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`\nCONCENTRATION: flags across ${Object.keys(bySha).length} commits (of ${new Set(scored.map((s) => s.sha)).size} sampled); worst: ${topSha.map(([s, n]) => `${s}:${n}`).join(", ")}`);

console.log("\nEVERY FLAG");
for (const s of flagged) {
  const d = s.d;
  console.log(`  ${s.v.toUpperCase().padEnd(6)} ${s.repo}/${s.sha} ${s.file}  [${s.why}]  tw=${(d.test_weakened ?? 0).toFixed(2)} se=${(d.security_touch ?? 0).toFixed(2)} dd=${(d.destructive_data ?? 0).toFixed(2)} sc=${(d.scope_creep ?? 0).toFixed(2)} risk=${(d.risk ?? 0).toFixed(2)}`);
}
