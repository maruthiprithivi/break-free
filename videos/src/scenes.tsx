import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { glow, mono, sans, theme } from "./theme";
import { Bar, Chip, Col, Panel, Row, Stamp, Terminal, TypedLine, Wires, Wordmark, arrow, fanout } from "./ui";

export type SceneProps = {
  stage: number;
  stageProgress: number;
  frame: number;
  duration: number;
  install: string;
  repo: string;
  videoId: string;
  lineId: string;
};

/* ------------------------------------------------------------- animation */

/** 0 -> 1 between `at` and `at + len` of a beat's progress, eased out. */
const at = (p: number, start: number, len = 0.25) =>
  interpolate(p, [start, start + len], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });

/** Enter: fade up and settle. Every element arrives, nothing is simply present. */
const Enter: React.FC<{ p: number; start?: number; dy?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ p, start = 0, dy = 18, children, style }) => {
  const t = at(p, start);
  return <div style={{ opacity: t, transform: `translateY(${(1 - t) * dy}px)`, ...style }}>{children}</div>;
};

const Stage: React.FC<{ children: React.ReactNode; gap?: number }> = ({ children, gap = 26 }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingTop: 168, paddingBottom: 222 }}>
    <Col gap={gap} style={{ alignItems: "center" }}>{children}</Col>
  </AbsoluteFill>
);

const Head: React.FC<{ children: React.ReactNode; colour?: string; size?: number }> = ({ children, colour, size = 27 }) => (
  <div style={{ fontFamily: sans, fontSize: size, fontWeight: 600, color: colour ?? theme.text, letterSpacing: -0.2 }}>{children}</div>
);

const Kv: React.FC<{ k: string; v: React.ReactNode; colour?: string; w?: number }> = ({ k, v, colour, w = 104 }) => (
  <Row gap={18} style={{ alignItems: "baseline" }}>
    <span style={{ fontFamily: mono, fontSize: 18, color: theme.faint, width: w, flexShrink: 0 }}>{k}</span>
    <span style={{ fontFamily: mono, fontSize: 20, color: colour ?? theme.text }}>{v}</span>
  </Row>
);

const Node: React.FC<{ name: string; sub?: string; state?: "idle" | "run" | "pass" | "fail" | "skip"; progress?: number; width?: number }> = ({ name, sub, state = "idle", progress = 0, width = 250 }) => {
  const colour = state === "pass" ? theme.green : state === "fail" ? theme.red : state === "run" ? theme.cyan : theme.line;
  return (
    <Panel accent={colour} width={width} padding={18} dimmed={state === "skip"}>
      <Col gap={10}>
        <Row gap={10} style={{ justifyContent: "space-between" }}>
          <span style={{ fontFamily: mono, fontSize: 21, color: theme.text }}>{name}</span>
          <span style={{ fontFamily: mono, fontSize: 14, letterSpacing: 2, color: colour === theme.line ? theme.faint : colour }}>
            {state === "skip" ? "SKIPPED" : state === "idle" ? "" : state.toUpperCase()}
          </span>
        </Row>
        {sub ? <span style={{ fontFamily: mono, fontSize: 16, color: theme.faint }}>{sub}</span> : null}
        {state === "run" ? <Bar progress={progress} width={width - 36} /> : null}
      </Col>
    </Panel>
  );
};

/* ------------------------------------------------------------- intro beats */

const Title: React.FC<SceneProps> = ({ stageProgress: p, repo }) => {
  const rule = interpolate(at(p, 0.12, 0.35), [0, 1], [0, 660]);
  return (
    <Stage gap={0}>
      <Enter p={p} dy={26}><Wordmark size={126} /></Enter>
      <div style={{ height: 1, width: rule, marginTop: 28, background: `linear-gradient(90deg, ${theme.green}, transparent)` }} />
      <Enter p={p} start={0.3} style={{ marginTop: 26 }}>
        <div style={{ fontFamily: sans, fontSize: 38, color: theme.dim }}>you say who does the work</div>
      </Enter>
      <Enter p={p} start={0.5} style={{ marginTop: 30 }}>
        <Row gap={14}>
          <Chip colour={theme.green}>MCP server</Chip>
          <Chip>Claude Code and Codex</Chip>
          <Chip colour={theme.violet}>{repo}</Chip>
        </Row>
      </Enter>
    </Stage>
  );
};

const Ask: React.FC<SceneProps> = ({ stageProgress: p }) => (
  <Stage>
    <Enter p={p}>
      <Terminal title="you" width={980}>
        <Row gap={12} style={{ alignItems: "baseline" }}>
          <span style={{ fontFamily: mono, fontSize: 23, color: theme.green }}>&gt;</span>
          <TypedLine text="use deepseek for the router tests" reveal={at(p, 0.05, 0.3)} caret size={23} />
        </Row>
      </Terminal>
    </Enter>
    <Row gap={18}>
      {["did it actually run?", "who really did it?", "was it checked?"].map((q, i) => (
        <Enter key={q} p={p} start={0.42 + i * 0.1}>
          <Panel accent={theme.line} padding={16} width={290}>
            <span style={{ fontFamily: sans, fontSize: 21, color: theme.dim }}>{q}</span>
          </Panel>
        </Enter>
      ))}
    </Row>
    <Enter p={p} start={0.78}><Stamp state="fail" detail="unverified" /></Enter>
  </Stage>
);

const RoutingSay: React.FC<SceneProps> = ({ stageProgress: p }) => (
  <Stage gap={40}>
    <Enter p={p}>
      <Row gap={16} style={{ alignItems: "baseline" }}>
        <span style={{ fontFamily: sans, fontSize: 46, color: theme.dim }}>use</span>
        <span style={{ fontFamily: mono, fontSize: 46, color: theme.green, borderBottom: `2px solid ${theme.green}`, paddingBottom: 4 }}>X</span>
        <span style={{ fontFamily: sans, fontSize: 46, color: theme.dim }}>for</span>
        <span style={{ fontFamily: mono, fontSize: 46, color: theme.cyan, borderBottom: `2px solid ${theme.cyan}`, paddingBottom: 4 }}>Y</span>
      </Row>
    </Enter>
    <Wires w={620} h={64} lines={fanout(620, 64, [150, 470])} colour={theme.line} dashed />
    <Row gap={60}>
      <Enter p={p} start={0.45}>
        <Panel accent={theme.cyan} width={300}><Col gap={8}><Head colour={theme.cyan} size={22}>X is a model</Head><span style={{ fontFamily: mono, fontSize: 18, color: theme.dim }}>delegate it</span></Col></Panel>
      </Enter>
      <Enter p={p} start={0.6}>
        <Panel accent={theme.violet} width={300}><Col gap={8}><Head colour={theme.violet} size={22}>X is a harness</Head><span style={{ fontFamily: mono, fontSize: 18, color: theme.dim }}>open it</span></Col></Panel>
      </Enter>
    </Row>
  </Stage>
);

const RoutingModel: React.FC<SceneProps> = ({ stageProgress: p }) => {
  const pick = at(p, 0.3, 0.2);
  return (
    <Stage gap={34}>
      <Row gap={16}>
        {["deepseek", "kimi", "glm", "ollama (local)"].map((m, i) => (
          <Enter key={m} p={p} start={i * 0.06}>
            <Panel accent={i === 0 ? theme.cyan : theme.line} padding={16} width={220} style={{ transform: i === 0 ? `scale(${1 + pick * 0.05})` : undefined }}>
              <Row gap={10}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: i === 0 ? theme.cyan : theme.faint, boxShadow: i === 0 ? glow(theme.cyan, 12 * pick) : undefined }} />
                <span style={{ fontFamily: mono, fontSize: 19, color: i === 0 ? theme.text : theme.faint }}>{m}</span>
              </Row>
            </Panel>
          </Enter>
        ))}
      </Row>
      <Wires w={120} h={40} lines={arrow(120, 20)} colour={theme.cyan} />
      <Enter p={p} start={0.55}>
        <Panel accent={theme.cyan} width={560}>
          <Col gap={12}>
            <Head colour={theme.cyan} size={22}>delegated worker</Head>
            <Row gap={10}>
              {["read", "write", "run"].map((c, i) => (
                <Enter key={c} p={p} start={0.65 + i * 0.06}><Chip size={18}>{c}</Chip></Enter>
              ))}
              <Enter p={p} start={0.85}><Chip size={18} muted>no git</Chip></Enter>
            </Row>
          </Col>
        </Panel>
      </Enter>
    </Stage>
  );
};

const RoutingHarness: React.FC<SceneProps> = ({ stageProgress: p }) => {
  const open = at(p, 0.1, 0.3);
  return (
    <Stage gap={30}>
      <div style={{ transform: `scale(${0.92 + open * 0.08})`, opacity: open }}>
        <Terminal title="tmux: break-free-9f2a1c   (codex)" width={1020}>
          <TypedLine text="codex" reveal={at(p, 0.4, 0.2)} colour={theme.green} size={22} caret />
          <div style={{ fontFamily: mono, fontSize: 19, color: theme.faint, marginTop: 8, opacity: at(p, 0.55) }}>
            its own memory, skills and tools, in your repository
          </div>
        </Terminal>
      </div>
      <Enter p={p} start={0.72}>
        <Row gap={14}>
          <Chip colour={theme.violet}>your subscription</Chip>
          <Chip muted>not metered API calls</Chip>
          <Chip colour={theme.green}>attach any time</Chip>
        </Row>
      </Enter>
    </Stage>
  );
};

const Verify: React.FC<SceneProps> = ({ stageProgress: p }) => {
  const run = at(p, 0.25, 0.4);
  return (
    <Stage gap={26}>
      <Enter p={p}>
        <Panel accent={theme.line} width={880}>
          <Col gap={12}>
            <Kv k="worker" v="deepseek/deepseek-v4-pro" />
            <Kv k="claimed" v={'"done, tests pass"'} colour={theme.dim} />
          </Col>
        </Panel>
      </Enter>
      <Wires w={60} h={44} lines={[[30, 0, 30, 44]]} colour={theme.green} />
      <Enter p={p} start={0.22}>
        <Panel accent={run > 0.9 ? theme.green : theme.cyan} width={880}>
          <Col gap={14}>
            <Kv k="gateway" v="npm test -- router" colour={theme.cyan} />
            <Bar progress={run} colour={run > 0.9 ? theme.green : theme.cyan} width={820} />
            {run > 0.9 ? <Kv k="exit" v="0" colour={theme.green} /> : null}
          </Col>
        </Panel>
      </Enter>
      {run > 0.95 ? <Enter p={p} start={0.8}><Stamp state="pass" detail="a real exit code, not a claim" /></Enter> : null}
    </Stage>
  );
};

const FollowThrough: React.FC<SceneProps> = ({ stageProgress: p, frame }) => {
  const pulse = 0.65 + 0.35 * Math.sin(frame / 7);
  const rows: [string, string, boolean][] = [
    ["tests", "npm test — exit 0", true],
    ["docs", "no check requested", true],
    ["ci abc1234", "run still in flight", false],
  ];
  return (
    <Stage gap={26}>
      <Enter p={p}>
        <Panel accent={theme.line} width={900}>
          <Col gap={14}>
            <Head size={22}>open work</Head>
            {rows.map(([k, v, done], i) => (
              <Enter key={k} p={p} start={0.1 + i * 0.12}>
                <Row gap={18} style={{ alignItems: "baseline" }}>
                  <span style={{
                    fontFamily: mono, fontSize: 19, width: 18,
                    color: done ? theme.green : theme.amber,
                    opacity: done ? 1 : pulse,
                  }}>{done ? "x" : "o"}</span>
                  <span style={{ fontFamily: mono, fontSize: 20, color: done ? theme.faint : theme.text, width: 150 }}>{k}</span>
                  <span style={{ fontFamily: mono, fontSize: 18, color: done ? theme.faint : theme.amber, opacity: done ? 1 : pulse }}>{v}</span>
                </Row>
              </Enter>
            ))}
          </Col>
        </Panel>
      </Enter>
      <Enter p={p} start={0.7}>
        <div style={{
          fontFamily: mono, fontSize: 21, color: theme.amber, padding: "12px 26px",
          border: `1px solid ${theme.amber}`, borderRadius: 999, background: "rgba(251,191,36,0.08)",
        }}>
          one item still open — the turn does not end here
        </div>
      </Enter>
    </Stage>
  );
};

const Install: React.FC<SceneProps> = ({ stageProgress: p, install, repo }) => {
  const typed = at(p, 0.02, 0.4);
  const out = at(p, 0.45, 0.3);
  const lines: [string, string][] = [
    ["== Preflight", theme.dim],
    ["  PASS  Node 22.22.2", theme.green],
    ["  PASS  Claude Code CLI", theme.green],
    ["  PASS  MCP handshake ok - 13 tools", theme.green],
    ["  GREEN - everything checks out.", theme.green],
  ];
  return (
    <Stage gap={30}>
      <Enter p={p}>
        <Terminal title="install" width={1160}>
          <Row gap={12} style={{ alignItems: "baseline" }}>
            <span style={{ fontFamily: mono, fontSize: 23, color: theme.green }}>$</span>
            <TypedLine text={install} reveal={typed} caret={typed < 1} size={22} />
          </Row>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
            {lines.map(([t, c], i) => (
              <div key={t} style={{ fontFamily: mono, fontSize: 20, color: c, whiteSpace: "pre", opacity: at(out, i * 0.16, 0.2) }}>{t}</div>
            ))}
          </div>
        </Terminal>
      </Enter>
      <Enter p={p} start={0.75}>
        <Col gap={10} style={{ alignItems: "center" }}>
          <Wordmark size={56} />
          <span style={{ fontFamily: mono, fontSize: 22, color: theme.dim }}>{repo}</span>
        </Col>
      </Enter>
    </Stage>
  );
};

/* -------------------------------------------------- per-video scenario beats */

const TASKS: Record<string, { head: string; kv: [string, string][] }> = {
  delegate: { head: "Unit tests for src/router.ts", kv: [["needs", "care, not genius"], ["alias", "fast"]] },
  handoff: { head: "A job for Codex", kv: [["why", "its own memory, skills, tools"], ["where", "this repository"]] },
  parallel: { head: "Rate limiting", kv: [["pieces", "core, tests, docs, wiring"], ["models", "not all the same"]] },
  verdict: { head: "About to land", kv: [["diff", "4 files, +212 -37"], ["want", "eyes that did not write it"]] },
  guard: { head: "Done and pushed", kv: [["commit", "abc1234"], ["risk", "this is where it gets forgotten"]] },
  resume: { head: "It is Monday", kv: [["context", "last week is gone"], ["repo", "unchanged"]] },
};

const Task: React.FC<SceneProps> = ({ stageProgress: p, videoId }) => {
  const t = TASKS[videoId] ?? { head: "A task", kv: [] };
  return (
    <Stage>
      <Enter p={p} dy={24}>
        <Panel accent={theme.line} width={880}>
          <Col gap={16}>
            <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: 3, color: theme.faint }}>THE TASK</span>
            <Head size={34}>{t.head}</Head>
            {t.kv.map(([k, v], i) => (
              <Enter key={k} p={p} start={0.3 + i * 0.14}><Kv k={k} v={v} w={120} /></Enter>
            ))}
          </Col>
        </Panel>
      </Enter>
    </Stage>
  );
};

const SAYS: Record<string, string> = {
  delegate: "use deepseek to write them, verify with npm test",
  handoff: "use codex for this one",
  parallel: "core on deepseek, docs local, wiring on kimi; docs and wiring wait for core",
  verdict: "have kimi review it",
  guard: "git push",
  resume: "everything was written down as it happened",
};

const Say: React.FC<SceneProps> = ({ stageProgress: p, videoId }) => (
  <Stage>
    <Enter p={p}>
      <Terminal title={videoId === "resume" ? ".break-free/" : "you"} width={1180}>
        <Row gap={12} style={{ alignItems: "baseline" }}>
          <span style={{ fontFamily: mono, fontSize: 23, color: theme.green }}>{videoId === "resume" ? "#" : ">"}</span>
          <TypedLine text={SAYS[videoId] ?? ""} reveal={at(p, 0.03, 0.55)} caret size={22} />
        </Row>
      </Terminal>
    </Enter>
  </Stage>
);

const Route: React.FC<SceneProps> = ({ stageProgress: p, videoId, frame }) => {
  if (videoId === "parallel") {
    const run = at(p, 0.35, 0.5);
    return (
      <Stage gap={0}>
        <Node name="core" sub="verified: npm test" state="pass" width={290} />
        <Wires w={802} h={50} lines={fanout(802, 50, [125, 401, 677])} colour={theme.green} />
        <Row gap={26}>
          <Node name="tests" sub="deepseek" state={run > 0.85 ? "pass" : "run"} progress={run} />
          <Node name="docs" sub="ollama, local" state={run > 0.85 ? "pass" : "run"} progress={run * 0.85} />
          <Node name="wiring" sub="kimi" state={run > 0.85 ? "pass" : "run"} progress={run * 0.92} />
        </Row>
      </Stage>
    );
  }
  if (videoId === "handoff") {
    return (
      <Stage gap={26}>
        <Enter p={p}><Row gap={30}>
          <Panel accent={theme.line} width={280} dimmed><Col gap={6}><span style={{ fontFamily: mono, fontSize: 18, color: theme.faint }}>a model?</span><span style={{ fontFamily: mono, fontSize: 20, color: theme.faint }}>no</span></Col></Panel>
          <Panel accent={theme.violet} width={280}><Col gap={6}><span style={{ fontFamily: mono, fontSize: 18, color: theme.violet }}>a harness</span><span style={{ fontFamily: mono, fontSize: 20, color: theme.text }}>codex</span></Col></Panel>
        </Row></Enter>
        <Wires w={60} h={44} lines={[[30, 0, 30, 44]]} colour={theme.violet} />
        <Enter p={p} start={0.45}>
          <Terminal title="tmux: break-free-9f2a1c" width={900}>
            <TypedLine text="codex" reveal={at(p, 0.6, 0.2)} colour={theme.green} size={21} caret />
          </Terminal>
        </Enter>
      </Stage>
    );
  }
  if (videoId === "guard") {
    const fail = at(p, 0.45, 0.2);
    return (
      <Stage gap={24}>
        <Enter p={p}>
          <Panel accent={fail > 0.5 ? theme.red : theme.cyan} width={940}>
            <Col gap={12}>
              <Kv k="run" v="pages build and deployment" />
              <Kv k="commit" v="abc1234" />
              <Bar progress={at(p, 0.1, 0.35)} colour={fail > 0.5 ? theme.red : theme.cyan} width={880} />
              {fail > 0.5 ? <Kv k="conclusion" v="failure" colour={theme.red} /> : null}
            </Col>
          </Panel>
        </Enter>
        {fail > 0.6 ? (
          <Enter p={p} start={0.68}>
            <Panel accent={theme.red} width={940}>
              <Col gap={8}>
                <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: 3, color: theme.red }}>NOW OPEN WORK</span>
                <span style={{ fontFamily: mono, fontSize: 19, color: theme.text }}>ci.failed  abc1234  (build)</span>
                <span style={{ fontFamily: mono, fontSize: 17, color: theme.dim }}>github.com/…/actions/runs/35350299640</span>
              </Col>
            </Panel>
          </Enter>
        ) : null}
      </Stage>
    );
  }
  // delegate + verdict: a hand-off between two parties
  const right = videoId === "verdict" ? { label: "reviewer", name: "kimi-k2.7-code", colour: theme.violet, note: "never the same vendor" }
                                      : { label: "worker", name: "deepseek-v4-flash", colour: theme.cyan, note: "read - write - run" };
  return (
    <Stage gap={0}>
      <Row gap={34}>
        <Enter p={p}>
          <Panel accent={theme.green} width={360}><Col gap={10}>
            <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: 3, color: theme.green }}>{videoId === "verdict" ? "AUTHOR" : "LEAD"}</span>
            <Head size={24}>{videoId === "verdict" ? "deepseek-v4-pro" : "Claude Code"}</Head>
          </Col></Panel>
        </Enter>
        <div style={{ opacity: at(p, 0.3), alignSelf: "center" }}>
          <Wires w={120} h={40} lines={arrow(120, 20)} colour={right.colour} />
        </div>
        <Enter p={p} start={0.42}>
          <Panel accent={right.colour} width={420}><Col gap={10}>
            <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: 3, color: right.colour }}>{right.label.toUpperCase()}</span>
            <Head size={24}>{right.name}</Head>
            <span style={{ fontFamily: mono, fontSize: 18, color: theme.dim }}>{right.note}</span>
          </Col></Panel>
        </Enter>
      </Row>
      <div style={{ height: 18 }} />
      <div style={{ opacity: 0.45 + 0.25 * Math.sin(frame / 9), fontFamily: mono, fontSize: 17, color: theme.faint }}>
        {videoId === "verdict" ? "the real diff travels, not a summary" : "nothing else is granted"}
      </div>
    </Stage>
  );
};

const Result: React.FC<SceneProps> = ({ stageProgress: p, videoId }) => {
  const blocks: Record<string, React.ReactNode> = {
    delegate: (
      <Panel accent={theme.green} width={900}><Col gap={12}>
        <Row gap={16} style={{ justifyContent: "space-between" }}>
          <span style={{ fontFamily: mono, fontSize: 21 }}>src/router.test.ts</span>
          <span style={{ fontFamily: mono, fontSize: 21, color: theme.green }}>+148  -0</span>
        </Row>
        <div style={{ height: 1, background: theme.line }} />
        <Kv k="verified" v="npm test -- router, exit 0" colour={theme.green} w={120} />
        <Kv k="model" v="deepseek/deepseek-v4-flash" w={120} />
      </Col></Panel>
    ),
    handoff: (
      <Panel accent={theme.violet} width={900}><Col gap={12}>
        <Kv k="session" v="break-free-9f2a1c   running" colour={theme.violet} w={120} />
        <Kv k="attach" v="tmux attach -t break-free-9f2a1c" w={120} />
        <Kv k="billed to" v="your Codex subscription" colour={theme.green} w={120} />
      </Col></Panel>
    ),
    parallel: (
      <Panel accent={theme.green} width={980}><Col gap={11}>
        <Head colour={theme.green} size={22}>one report</Head>
        <Kv k="core" v="pass - npm test, exit 0" colour={theme.green} w={110} />
        <Kv k="tests" v="pass - npm test, exit 0" colour={theme.green} w={110} />
        <Kv k="docs" v="pass - no check requested" colour={theme.green} w={110} />
        <Kv k="wiring" v="fail - npm test, exit 1" colour={theme.red} w={110} />
      </Col></Panel>
    ),
    verdict: (
      <Panel accent={theme.violet} width={960}><Col gap={9}>
        {['"verdict": "revise",', '"issues": [', '  { "file": "src/ratelimit.ts", "line": 84,', '    "issue": "window resets on read, not write" }', "]"].map((t, i) => (
          <div key={i} style={{ fontFamily: mono, fontSize: 20, color: i === 0 ? theme.amber : theme.text, opacity: at(p, i * 0.1, 0.18) }}>{t}</div>
        ))}
      </Col></Panel>
    ),
    guard: (
      <Panel accent={theme.red} width={1020}><Col gap={12}>
        <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: 3, color: theme.red }}>STOP HOOK</span>
        <div style={{ fontFamily: mono, fontSize: 19, color: theme.text, lineHeight: 1.5 }}>
          {'{"decision":"block","reason":"CI FAILED on abc1234 (build)'}
        </div>
        <div style={{ fontFamily: mono, fontSize: 19, color: theme.text, lineHeight: 1.5 }}>
          {'  - fix it before ending the turn"}'}
        </div>
      </Col></Panel>
    ),
    resume: (
      <Terminal title="claude code" width={1060}>
        {[["in progress", "T-014 rate limiting - wiring", theme.cyan], ["blocked", "T-016 release - waits on T-014", theme.amber], ["ready", "T-017 document the limiter", theme.green]].map(([k, v, c], i) => (
          <Row key={k as string} gap={20} style={{ alignItems: "baseline", opacity: at(p, 0.15 + i * 0.14, 0.2) }}>
            <span style={{ fontFamily: mono, fontSize: 18, color: c as string, width: 150 }}>{k as string}</span>
            <span style={{ fontFamily: mono, fontSize: 19, color: theme.text }}>{v as string}</span>
          </Row>
        ))}
      </Terminal>
    ),
  };
  return <Stage><Enter p={p} dy={22}>{blocks[videoId] ?? null}</Enter></Stage>;
};

export const scenes: Record<string, React.FC<SceneProps>> = {
  title: Title,
  ask: Ask,
  "routing-say": RoutingSay,
  "routing-model": RoutingModel,
  "routing-harness": RoutingHarness,
  verify: Verify,
  followthrough: FollowThrough,
  install: Install,
  task: Task,
  say: Say,
  route: Route,
  result: Result,
};

export const UnknownScene: React.FC<SceneProps> = () => <Stage><span style={{ fontFamily: mono, color: theme.faint }}>—</span></Stage>;
