// Mine REAL diffs from real repository history into a tripwire bench set.
//
// Why this exists: `tripwire-set.jsonl` is 100 clean diffs *built to be hard* — 44 of them written to
// defeat a keyword rule. That set answers "does the tripwire survive an adversary?" and it says the
// false-flag rate is 14%. It cannot answer the question a user actually has, which is "how often does
// this cry wolf on ordinary work?". Only real history can answer that.
//
// The label is the honest weakness of this set and is stated wherever the numbers are used: a merged
// commit is *presumed* honest, not known to be. A commit that weakened a test and got away with it is
// scored against the tripwire here. That noise is why this is a second column beside the seeded set
// rather than a replacement for it.
//
//   node bench/make-natural-set.mjs --repos <a,b> --limit 200 --out bench/tripwire-natural.jsonl
//
// Each row carries the file header alongside its hunk, so the tripwire sees the path — which is what
// it gets in production, where the diff arrives from `git diff`. (The seeded set omits it.)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const repos = flag("repos", "").split(",").filter(Boolean);
const limit = Number(flag("limit", "200"));
// Hunks per commit. A single large commit (a rename sweep, a rebuilt video pipeline) must not own the
// corpus: the first cut took 70 hunks from ONE commit and 210 from eleven, which measures that commit.
const perCommit = Number(flag("per-commit", "2"));
const outFile = flag("out", "bench/tripwire-natural.jsonl");
if (!repos.length) {
  console.error("usage: node bench/make-natural-set.mjs --repos <repoA,repoB> [--limit 200] [--out file]");
  process.exit(2);
}

/** Generated, vendored, binary or lock content is not "work" — a diff there says nothing about intent. */
const SKIP = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)(yarn|pnpm-lock)\.(lock|yaml)$/,
  /(^|\/)(Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
  /(^|\/)(node_modules|dist|build|vendor|\.next|target|__pycache__)\//,
  /\.(min\.js|map|snap|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|mp4|webm|zip|gz|wasm|lock)$/,
  /\.break-free\//,
];
const skip = (p) => !p || SKIP.some((re) => re.test(p));

function git(repo, argv, max = 64 * 1024 * 1024) {
  return execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: max });
}

/** Every hunk in one commit's diff, each carrying the file header so the path reaches the model. */
function hunksOf(repo, sha) {
  const out = git(repo, ["show", "--no-color", "--unified=3", "--no-renames", "--format=%s%x00", sha]);
  const nul = out.indexOf("\u0000");
  const task = out.slice(0, nul).trim().split("\n")[0] || "(no subject)";
  const patch = out.slice(nul + 1);
  const found = [];
  let file = null;
  let header = [];
  let hunk = [];
  const flush = () => {
    if (file && hunk.length) found.push({ file, text: [...header, ...hunk].join("\n") });
    hunk = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/ b\/(.+)$/);
      file = m ? m[1] : null;
      header = [line];
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      hunk = [line];
      continue;
    }
    if (!hunk.length && (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file") || line.startsWith("deleted file"))) {
      header.push(line);
      continue;
    }
    if (hunk.length) hunk.push(line);
  }
  flush();
  return { task, hunks: found.filter((h) => !skip(h.file) && h.text.includes("\n+") ) };
}

const rows = [];
const perRepo = Math.max(1, Math.ceil(limit / repos.length));
for (const repo of repos) {
  if (!fs.existsSync(path.join(repo, ".git")) && !fs.existsSync(path.join(repo, ".git", "HEAD"))) {
    // A worktree's .git is a file, so existsSync on the dir is not enough — let git decide.
    try { git(repo, ["rev-parse", "--git-dir"]); } catch { console.error(`skip (not a git repo): ${repo}`); continue; }
  }
  // Spread across history rather than taking the newest: one author's habits are not a corpus.
  const shas = git(repo, ["rev-list", "--no-merges", "HEAD"]).split("\n").filter(Boolean);
  const want = Math.min(shas.length, perRepo * 3);
  const stride = Math.max(1, Math.floor(shas.length / want));
  const picked = [];
  for (let i = 0; i < shas.length && picked.length < want; i += stride) picked.push(shas[i]);

  let taken = 0;
  for (const sha of picked) {
    if (taken >= perRepo) break;
    let got;
    try {
      got = hunksOf(repo, sha);
    } catch {
      continue;
    }
    let fromThisCommit = 0;
    for (const h of got.hunks) {
      if (taken >= perRepo || fromThisCommit >= perCommit) break;
      if (rows.some((r) => r.sha === sha && r.file === h.file)) continue;
      rows.push({
        id: `nat-${String(rows.length + 1).padStart(3, "0")}`,
        repo: path.basename(repo),
        sha: sha.slice(0, 10),
        file: h.file,
        task: got.task,
        label: "clean",
        kinds: [],
        hunk: h.text,
      });
      taken++;
      fromThisCommit++;
    }
  }
  console.error(`${path.basename(repo)}: ${taken} hunks from ${new Set(rows.filter((r) => r.repo === path.basename(repo)).map((r) => r.sha)).size} commits`);
}

if (!rows.length) {
  console.error("no hunks mined — check the repo paths");
  process.exit(1);
}
fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const files = new Set(rows.map((r) => r.file));
console.error(`wrote ${outFile}: ${rows.length} hunks, ${files.size} files, ${new Set(rows.map((r) => r.repo)).size} repos`);
