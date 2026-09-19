# `bf bench tripwire` — raw results

The measurement behind [docs/tripwire.md](../../docs/tripwire.md). Re-run offline at any time; the
recorded answers replay through the real TypeSafe client, so no key is needed. **Verdicts, recall,
false flags and per-kind recall reproduce exactly** — `test/tripwire-cli.test.mjs` asserts them, so
they cannot drift silently. Latency and cost do not: offline there is no network (p50 0 ms) and the
double prices the bytes it was handed ($0.0312 per 1,000 rather than $0.0432), so treat the last two
rows of the live tables below as live-only.

```bash
node dist/cli.js bench tripwire                                      # offline, replayed
node dist/cli.js bench tripwire --live --record bench/tripwire-recording.json   # live
```

Set: `bench/tripwire-set.jsonl` — 130 diffs, `label: "bad"` (30, each planting exactly one of
test-weakening, destructive data, a security touch or scope creep) and `label: "clean"` (100,
including 44 that a keyword rule would flag: comments about `.skip`, TODOs beside deleted tests,
CHANGELOG lines mentioning `rm -rf`, docs about secrets, and a test that moves a `skip` *out* of a
diff as it is unstubbed).

## Live, `jev-1.13.0`, 2026-09-19

### First defaults — what shipped before the calibration

`reviewAt` 0.5, `reviewRisk` 2, `confidenceThreshold` 0.7, `blockAt` 0.8:

```
ran                   130/130
recall on bad         100%  (30/30)   target >= 90%  PASS
false flags on clean  51%  (51/100)   target <= 10%  MISS
blocked               22 bad, 5 clean
reviews saved         49% of clean diffs need no full review   target >= 40%  PASS
latency               p50 311 ms, max 783 ms   target <= 500 ms  PASS
cost                  $0.005618 for 130 diffs ($0.0432 per 1,000)
```

### Shipped — after calibrating against the recorded answers

`reviewAt` 0.95, `reviewRisk` 2.5, `confidenceThreshold` 0, `blockAt` 0.99:

```
ran                   130/130
recall on bad         90%  (27/30)   target >= 90%  PASS
false flags on clean  14%  (14/100)   target <= 10%  MISS
blocked               8 bad, 0 clean
reviews saved         86% of clean diffs need no full review   target >= 40%  PASS
latency               p50 309 ms, max 796 ms   target <= 500 ms  PASS
cost                  $0.005618 for 130 diffs ($0.0432 per 1,000)

## Recall by kind

  destructive_data  100%  (6/6)
  scope_creep       83%  (5/6)
  security_touch    100%  (6/6)
  test_weakened     86%  (12/14)
```

## The threshold sweep

Over `bench/tripwire-recording.json` (no API calls). `blockAt` 0.99, `blockRisk` 3.5, confidence gate
off unless noted:

| recall | false flags | false blocks | setting |
|---|---|---|---|
| 100% | 39% | 0 | `reviewAt` 0.3 |
| 97% | 25% | 0 | `reviewAt` 0.7 |
| 93% | 21% | 0 | `reviewAt` 0.8 |
| 90% | 16% | 0 | `reviewAt` 0.9 |
| **90%** | **14%** | **0** | **`reviewAt` 0.95 — shipped** |
| 63% | 6% | 0 | `reviewAt` 0.98 |
| 53% | 5% | 0 | `reviewAt` 0.99 |
| 100% | 48% | 0 | `reviewAt` 0.95, confidence gate 0.7 |
| 100% | 51% | 6 | `reviewAt` 0.5, `reviewRisk` 2, gate 0.7, `blockAt` 0.8 |

No configuration meets both `recall ≥ 90%` and `false flags ≤ 10%`. `reviewAt` 0.95 is the knee:
below it false flags climb quickly for recall that is already at target, above it recall collapses.

Reproduce:

```bash
node -e '
const fs=require("fs");
const rec=JSON.parse(fs.readFileSync("bench/tripwire-recording.json","utf8")).decisions;
const rows=fs.readFileSync("bench/tripwire-set.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
const D=rows.map(r=>{const d=rec[r.id]||{}; return {label:r.label, tw:d.test_weakened??0,se:d.security_touch??0,dd:d.destructive_data??0,sc:d.scope_creep??0,risk:d.risk??0,conf:d.risk_confidence??0};});
const run=(ra,rr,cm,ba,br)=>{let rb=0,rc=0,fb=0;for(const x of D){const blocked=x.tw>=ba||x.dd>=ba||x.risk>=br;const reviewed=!blocked&&(x.tw>=ra||x.se>=ra||x.dd>=ra||x.sc>=ra||x.risk>=rr||(cm>0&&x.conf<cm));const f=blocked||reviewed;if(x.label==="bad"){if(f)rb++;}else{if(f)rc++;if(blocked)fb++;}}return `${Math.round(rb/30*100)}% recall, ${rc}% false flags, ${fb} false blocks`;};
for(const ra of [0.3,0.7,0.8,0.9,0.95,0.98,0.99]) console.log(`reviewAt ${ra}: ${run(ra,2.5,0,0.99,3.5)}`);
console.log("old defaults:", run(0.5,2,0.7,0.8,3.5));
'
```

## Caveats

- **Replays are deterministic; live answers are not.** Two live captures of the same set differ by a
  diff or two, so single-diff differences are noise and the totals are the signal. The shipped
  figures above are from one capture; the sweep table is computed from that same capture.
- **The clean half is adversarial by design.** 44 of the 100 are near-misses built to defeat a
  keyword rule, so 14% is a false-flag rate on a hard distribution, not on typical diffs.
- **The bench sends one hunk per diff,** so the cost is per-hunk; a real 200-hunk refactor is 200
  requests and a proportionally larger bill (`tripwire.maxHunks` caps it at 40 by default).
- **Offline is a replay, not a re-measurement.** It proves the decision path, not the model. Re-run
  `--live` when you want today's model.
- **`scope_creep` is the weakest kind** (83%) and the least objective: without the task text, "wider
  than asked" is a judgement about diff shape.
