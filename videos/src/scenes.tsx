import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { glow, mono, sans, theme } from "./theme";
import {
  arrow,
  Bar,
  Chip,
  Col,
  fanin,
  fanout,
  Flow,
  Label,
  Panel,
  Row,
  Stamp,
  Svg,
  Terminal,
  TypedLine,
  Wires,
  Wordmark,
} from "./ui";

export type SceneProps = {
  stage: number;
  stageProgress: number;
  frame: number;
  duration: number;
  install: string;
  repo: string;
};

/** Crossfade between groups of narration stages that cannot share the screen. */
const group = (stage: number, p: number, from: number, to: number) => {
  if (stage < from || stage > to + 1) return 0;
  if (stage === from && from !== 0) return Math.min(1, p * 5);
  if (stage === to + 1) return 1 - Math.min(1, p * 5);
  return 1;
};

const Layer: React.FC<{ opacity: number; children: React.ReactNode }> = ({ opacity, children }) =>
  opacity <= 0.002 ? null : (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingTop: 170,
        paddingBottom: 215,
        opacity,
      }}
    >
      {children}
    </AbsoluteFill>
  );

const Head: React.FC<{ children: React.ReactNode; colour?: string }> = ({ children, colour }) => (
  <div
    style={{
      fontFamily: sans,
      fontSize: 26,
      fontWeight: 600,
      color: colour ?? theme.text,
      letterSpacing: -0.2,
    }}
  >
    {children}
  </div>
);

const Kv: React.FC<{ k: string; v: React.ReactNode; colour?: string }> = ({ k, v, colour }) => (
  <Row gap={18} style={{ alignItems: "baseline" }}>
    <span style={{ fontFamily: mono, fontSize: 19, color: theme.faint, width: 104 }}>{k}</span>
    <span style={{ fontFamily: mono, fontSize: 21, color: colour ?? theme.text }}>{v}</span>
  </Row>
);

const Node: React.FC<{
  name: string;
  vendor?: string;
  state?: "idle" | "run" | "pass" | "fail" | "skip";
  progress?: number;
  width?: number;
}> = ({ name, vendor, state = "idle", progress = 0, width = 250 }) => {
  const colour =
    state === "pass" ? theme.green : state === "fail" ? theme.red : state === "run" ? theme.cyan : theme.line;
  return (
    <Panel accent={colour} width={width} padding={18} dimmed={state === "skip"}>
      <Col gap={10}>
        <Row gap={10} style={{ justifyContent: "space-between" }}>
          <span style={{ fontFamily: mono, fontSize: 21, color: theme.text }}>{name}</span>
          <span
            style={{
              fontFamily: mono,
              fontSize: 15,
              letterSpacing: 2,
              color: colour === theme.line ? theme.faint : colour,
            }}
          >
            {state === "skip" ? "SKIPPED" : state.toUpperCase()}
          </span>
        </Row>
        {vendor ? (
          <span style={{ fontFamily: mono, fontSize: 16, color: theme.faint }}>{vendor}</span>
        ) : null}
        {state === "run" ? <Bar progress={progress} width={width - 36} /> : null}
      </Col>
    </Panel>
  );
};

/* ------------------------------------------------------------------ intro */

const TitleScene: React.FC<SceneProps> = ({ frame, repo }) => {
  const rise = interpolate(frame, [0, 26], [26, 0], { extrapolateRight: "clamp" });
  const fade = interpolate(frame, [0, 22], [0, 1], { extrapolateRight: "clamp" });
  const rule = interpolate(frame, [18, 52], [0, 620], { extrapolateRight: "clamp" });
  const tag = interpolate(frame, [30, 58], [0, 1], { extrapolateRight: "clamp" });
  return (
    <Layer opacity={1}>
      <div style={{ transform: `translateY(${rise}px)`, opacity: fade }}>
        <Wordmark size={132} />
        <div style={{ height: 1, width: rule, marginTop: 30, background: `linear-gradient(90deg, ${theme.green}, transparent)` }} />
        <div
          style={{
            marginTop: 28,
            fontFamily: sans,
            fontSize: 40,
            color: theme.dim,
            opacity: tag,
            letterSpacing: -0.3,
          }}
        >
          the frontier model leads, other models execute
        </div>
        <Row gap={14} style={{ marginTop: 34, opacity: tag }}>
          <Chip colour={theme.green}>MCP server</Chip>
          <Chip>Claude Code and Codex</Chip>
          <Chip colour={theme.violet}>{repo}</Chip>
        </Row>
      </div>
    </Layer>
  );
};

const BottleneckScene: React.FC<SceneProps> = ({ stage, stageProgress }) => {
  const work = ["boilerplate", "unit tests", "migrations", "docs", "bulk edits", "refactors"];
  const cost = stage >= 1 ? (stage === 1 ? stageProgress : 1) : 0;
  return (
    <>
      <Layer opacity={group(stage, stageProgress, 0, 1)}>
        <Row gap={64}>
          <Col gap={12}>
            <Label>the work in one task</Label>
            {work.map((w, i) => (
              <div
                key={w}
                style={{
                  fontFamily: mono,
                  fontSize: 23,
                  color: theme.dim,
                  padding: "9px 20px",
                  borderRadius: 8,
                  border: `1px solid ${theme.line}`,
                  background: "rgba(255,255,255,0.02)",
                  opacity: interpolate(stageProgress, [i * 0.06, i * 0.06 + 0.2], [0.15, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                {w}
              </div>
            ))}
          </Col>
          <Col gap={18} style={{ alignItems: "center" }}>
            <div
              style={{
                width: 14,
                height: 300,
                borderRadius: 999,
                background: `linear-gradient(180deg, ${theme.amber}, rgba(251,191,36,0.15))`,
                boxShadow: glow("rgba(251,191,36,0.45)", 40 * (0.4 + cost)),
              }}
            />
            <Label colour={theme.amber}>frontier model</Label>
          </Col>
          <Panel accent={cost > 0.2 ? theme.amber : theme.line} width={420}>
            <Col gap={16}>
              <Head colour={theme.amber}>Top rate, for typing</Head>
              <Kv k="work" v="mostly mechanical" />
              <Kv k="model" v="the most expensive" />
              <Row gap={16}>
                <span style={{ fontFamily: mono, fontSize: 18, color: theme.faint, width: 104 }}>cost</span>
                <Bar progress={cost} colour={theme.amber} width={260} />
              </Row>
            </Col>
          </Panel>
        </Row>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 2, 2)}>
        <Row gap={46}>
          <Panel accent={theme.line} width={430}>
            <Col gap={14}>
              <Head>Hand it off blindly</Head>
              <Kv k="model" v="whatever is cheapest" />
              <Kv k="checks" v="none" colour={theme.red} />
              <Kv k="report" v={'"all tests pass"'} colour={theme.dim} />
            </Col>
          </Panel>
          <Wires w={110} h={40} lines={arrow(110, 20)} colour={theme.faint} />
          <Panel accent={theme.red} width={430}>
            <Col gap={16}>
              <Head colour={theme.red}>Nobody checked</Head>
              <Stamp state="fail" detail="claimed, never run" />
              <span style={{ fontFamily: sans, fontSize: 21, color: theme.dim }}>
                A worker grading its own homework is not verification.
              </span>
            </Col>
          </Panel>
        </Row>
      </Layer>
    </>
  );
};

const LeadCrewScene: React.FC<SceneProps> = ({ stage, stageProgress }) => {
  const crew = ["deepseek", "kimi", "glm", "minimax", "openrouter", "ollama (local)"];
  const gate = stage >= 3 ? (stage === 3 ? stageProgress : 1) : 0;
  const leadDetail = stage >= 1 ? 1 : 0.35;
  const crewDetail = stage >= 2 ? 1 : 0.35;
  return (
    <Layer opacity={1}>
      <Col gap={26} style={{ alignItems: "center" }}>
        <Panel accent={theme.green} width={840}>
          <Col gap={12}>
            <Row gap={16} style={{ justifyContent: "space-between" }}>
              <Head colour={theme.green}>Lead</Head>
              <span style={{ fontFamily: mono, fontSize: 18, color: theme.faint }}>
                Claude Code / Codex
              </span>
            </Row>
            <Row gap={10} style={{ flexWrap: "wrap", opacity: leadDetail }}>
              {["understands you", "decomposes", "designs", "writes the verification", "reviews", "owns the result"].map(
                (b) => (
                  <Chip key={b} colour={theme.green} size={18}>
                    {b}
                  </Chip>
                ),
              )}
            </Row>
          </Col>
        </Panel>

        <div
          style={{
            width: 640,
            padding: "14px 26px",
            borderRadius: 999,
            border: `1px solid ${gate > 0.1 ? theme.violet : theme.line}`,
            background: gate > 0.1 ? "rgba(167,139,250,0.08)" : "transparent",
            textAlign: "center",
            fontFamily: mono,
            fontSize: 22,
            color: gate > 0.1 ? theme.violet : theme.faint,
            boxShadow: gate > 0.1 ? glow("rgba(167,139,250,0.3)", 30) : undefined,
          }}
        >
          break-free-gateway
          <span style={{ fontSize: 17, color: theme.faint, marginLeft: 22 }}>
            one MCP server, installed once
          </span>
        </div>

        <Row gap={14} style={{ opacity: crewDetail, flexWrap: "wrap", justifyContent: "center", width: 980 }}>
          {crew.map((c) => (
            <Panel key={c} accent={theme.cyan} padding={16} width={290}>
              <Row gap={12}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: theme.cyan }} />
                <span style={{ fontFamily: mono, fontSize: 21, color: theme.text }}>{c}</span>
              </Row>
            </Panel>
          ))}
        </Row>
        <Label colour={theme.cyan}>crew: execution</Label>
      </Col>
    </Layer>
  );
};

const VerifyScene: React.FC<SceneProps> = ({ stage, stageProgress }) => {
  const jail = [
    ["run_command", "allow-list only, no shell: ; && | $() are rejected"],
    ["git_push", "refused on protected branches"],
    ["git", "no force, no reset, no rebase, no branch deletes"],
    ["read_file", "jailed to the workspace, .env and keys denied"],
    ["gh", "issues, PRs and Actions only, never repo or secret deletion"],
  ];
  const ledger = [
    ["HANDOFF.md", "resume brief: in progress, blocked, ready"],
    ["PLAN.md", "board by status, dependency graph"],
    ["tasks/T-001.md", "acceptance criteria, verify command, outcome"],
    ["notes/", "decisions and gotchas, injected into every worker"],
  ];
  return (
    <>
      <Layer opacity={group(stage, stageProgress, 0, 1)}>
        <Row gap={40} style={{ alignItems: "stretch" }}>
          <Panel accent={theme.green} width={560}>
            <Col gap={14}>
              <Label colour={theme.green}>written by the lead</Label>
              <Kv k="task" v="implement TokenBucket in src/ratelimit.ts" />
              <Kv k="accept" v="429 after N in window; window resets" />
              <Kv k="verify" v="npm test -- ratelimit" colour={theme.cyan} />
              <Kv k="caps" v="read - write - run" />
            </Col>
          </Panel>
          <Panel accent={stage >= 1 ? theme.green : theme.line} width={560}>
            <Col gap={14}>
              <Label colour={stage >= 1 ? theme.green : theme.faint}>run by the gateway</Label>
              <Kv k="worker" v="deepseek/deepseek-v4-pro" />
              <Kv k="claimed" v={'"done, tests pass"'} colour={theme.dim} />
              {stage >= 1 ? (
                <>
                  <Kv k="gateway" v="npm test -- ratelimit" colour={theme.cyan} />
                  <Kv k="exit" v="0" colour={theme.green} />
                  <Stamp state="pass" detail="a real exit code" />
                </>
              ) : null}
            </Col>
          </Panel>
        </Row>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 2, 2)}>
        <Col gap={0} style={{ alignItems: "center" }}>
          <Node name="core" vendor="strong - verified" state="pass" width={280} />
          <Wires w={802} h={52} lines={fanout(802, 52, [125, 401, 677])} colour={theme.green} />
          <Row gap={26}>
            <Node name="tests" vendor="fast" state="pass" />
            <Node name="docs" vendor="local" state="pass" />
            <Node name="wire" vendor="strong" state="fail" />
          </Row>
          <Wires
            w={802}
            h={52}
            lines={[[677, 0, 677, 26], [401, 26, 677, 26], [401, 26, 401, 52]]}
            colour={theme.red}
          />
          <Node name="ship" vendor="depends_on: wire" state="skip" width={280} />
          <div style={{ height: 26 }} />
          <Label colour={theme.faint}>a failed check blocks whatever depended on it</Label>
        </Col>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 3, 3)}>
        <Panel accent={theme.red} width={1080}>
          <Col gap={16}>
            <Head colour={theme.red}>What a worker cannot do</Head>
            {jail.map(([k, v]) => (
              <Row key={k} gap={22} style={{ alignItems: "baseline" }}>
                <span style={{ fontFamily: mono, fontSize: 21, color: theme.text, width: 180 }}>{k}</span>
                <span style={{ fontFamily: mono, fontSize: 19, color: theme.dim }}>{v}</span>
              </Row>
            ))}
          </Col>
        </Panel>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 4, 4)}>
        <Panel accent={theme.green} width={1000}>
          <Col gap={16}>
            <Head colour={theme.green}>.break-free/</Head>
            {ledger.map(([k, v]) => (
              <Row key={k} gap={22} style={{ alignItems: "baseline" }}>
                <span style={{ fontFamily: mono, fontSize: 21, color: theme.cyan, width: 230 }}>{k}</span>
                <span style={{ fontFamily: mono, fontSize: 19, color: theme.dim }}>{v}</span>
              </Row>
            ))}
            <Label>plain Markdown, committed with the repository</Label>
          </Col>
        </Panel>
      </Layer>
    </>
  );
};

const InstallScene: React.FC<SceneProps> = ({ frame, install, repo }) => {
  const typed = interpolate(frame, [10, 92], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(frame, [100, 130], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lines: [string, string][] = [
    ["== Preflight", theme.dim],
    ["  PASS  Node 22.22.2", theme.green],
    ["  PASS  Claude Code CLI", theme.green],
    ["== Postflight", theme.dim],
    ["  PASS  MCP handshake ok - 13 tools", theme.green],
    ["  GREEN - everything checks out. Good to go.", theme.green],
  ];
  return (
    <Layer opacity={1}>
      <Col gap={34} style={{ alignItems: "center" }}>
        <Terminal title="install" width={1180}>
          <Row gap={12} style={{ alignItems: "baseline" }}>
            <span style={{ fontFamily: mono, fontSize: 24, color: theme.green }}>$</span>
            <TypedLine text={install} reveal={typed} caret={typed < 1} size={23} />
          </Row>
          <div style={{ opacity: out, display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {lines.map(([t, c], i) => (
              <div
                key={t}
                style={{
                  fontFamily: mono,
                  fontSize: 21,
                  color: c,
                  whiteSpace: "pre",
                  opacity: interpolate(out, [i * 0.12, i * 0.12 + 0.2], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                {t}
              </div>
            ))}
          </div>
        </Terminal>
        <Col gap={12} style={{ alignItems: "center", opacity: out }}>
          <Wordmark size={64} />
          <span style={{ fontFamily: mono, fontSize: 24, color: theme.dim }}>{repo}</span>
        </Col>
      </Col>
    </Layer>
  );
};

/* -------------------------------------------------------------- scenarios */

const DelegateScene: React.FC<SceneProps> = ({ stage, stageProgress }) => (
  <>
    <Layer opacity={group(stage, stageProgress, 0, 0)}>
      <Panel accent={theme.line} width={880}>
        <Col gap={16}>
          <Label>on your desk</Label>
          <Head>Unit tests for src/router.ts</Head>
          <span style={{ fontFamily: sans, fontSize: 24, color: theme.dim }}>
            Alias expansion and fallback ordering. Careful work. Not hard work.
          </span>
        </Col>
      </Panel>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 1, 1)}>
      <Terminal title="claude code" width={1240}>
        <Row gap={12} style={{ alignItems: "baseline" }}>
          <span style={{ fontFamily: mono, fontSize: 23, color: theme.green }}>&gt;</span>
          <TypedLine
            text="/break-free-delegate fast write unit tests for src/router.ts covering alias expansion and fallback ordering"
            reveal={Math.min(1, stageProgress * 1.5)}
            caret
            size={22}
          />
        </Row>
        <div style={{ fontFamily: mono, fontSize: 20, color: theme.faint, marginTop: 8 }}>
          verify: npm test -- router
        </div>
      </Terminal>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 2, 2)}>
      <Row gap={40}>
        <Panel accent={theme.green} width={380}>
          <Col gap={12}>
            <Label colour={theme.green}>lead</Label>
            <Head>Claude Code</Head>
            <span style={{ fontFamily: mono, fontSize: 19, color: theme.dim }}>keeps the judgement</span>
          </Col>
        </Panel>
        <Wires w={120} h={40} lines={arrow(120, 20)} colour={theme.green} />
        <Panel accent={theme.cyan} width={480}>
          <Col gap={12}>
            <Label colour={theme.cyan}>worker</Label>
            <Head>deepseek-v4-flash</Head>
            <Row gap={10}>
              <Chip size={18}>read</Chip>
              <Chip size={18}>write</Chip>
              <Chip size={18}>run</Chip>
              <Chip size={18} muted>
                no git
              </Chip>
            </Row>
          </Col>
        </Panel>
      </Row>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 3, 3)}>
      <Panel accent={theme.green} width={900}>
        <Col gap={18}>
          <Label colour={theme.green}>the gateway runs it, after the worker</Label>
          <Kv k="command" v="npm test -- router" colour={theme.cyan} />
          <Kv k="output" v="14 passing, 0 failing" />
          <Kv k="exit" v="0" colour={theme.green} />
          <Stamp state="pass" detail="not a claim, a real exit code" />
        </Col>
      </Panel>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 4, 4)}>
      <Col gap={24} style={{ alignItems: "center" }}>
        <Panel accent={theme.cyan} width={860}>
          <Col gap={12}>
            <Row gap={16} style={{ justifyContent: "space-between" }}>
              <span style={{ fontFamily: mono, fontSize: 22, color: theme.text }}>src/router.test.ts</span>
              <span style={{ fontFamily: mono, fontSize: 22, color: theme.green }}>+148  -0</span>
            </Row>
            <div style={{ height: 1, background: theme.line }} />
            <Kv k="model" v="deepseek/deepseek-v4-flash" />
            <Kv k="verified" v="npm test -- router, exit 0" colour={theme.green} />
            <Kv k="your quota" v="unchanged" colour={theme.green} />
          </Col>
        </Panel>
      </Col>
    </Layer>
  </>
);

const ParallelScene: React.FC<SceneProps> = ({ stage, stageProgress }) => {
  const run = stage === 2 ? stageProgress : stage > 2 ? 1 : 0;
  const state = (i: number): "idle" | "run" | "pass" | "fail" | "skip" => {
    if (stage < 2) return "idle";
    if (stage === 2) return run > 0.75 ? "pass" : "run";
    return i === 2 ? "fail" : "pass";
  };
  return (
    <>
      <Layer opacity={group(stage, stageProgress, 0, 1)}>
        <Col gap={0} style={{ alignItems: "center" }}>
          <Node name="core" vendor="strong" state="idle" width={300} />
          {stage >= 1 ? (
            <Wires w={802} h={64} lines={fanout(802, 64, [125, 401, 677])} colour={theme.line} dashed />
          ) : (
            <div style={{ height: 64, display: "flex", alignItems: "center" }}>
              <Label>one feature, four pieces of work</Label>
            </div>
          )}
          <Row gap={26}>
            <Node name="tests" vendor="fast" state="idle" />
            <Node name="docs" vendor="local" state="idle" />
            <Node name="wire" vendor="strong" state="idle" />
          </Row>
          {stage >= 1 ? (
            <div style={{ height: 40, display: "flex", alignItems: "flex-end" }}>
              <Label colour={theme.faint}>depends_on: core</Label>
            </div>
          ) : null}
        </Col>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 2, 3)}>
        <Col gap={0} style={{ alignItems: "center" }}>
          <Node name="core" vendor="verified: npm test" state="pass" width={300} />
          <Wires w={802} h={52} lines={fanout(802, 52, [125, 401, 677])} colour={theme.green} />
          <Row gap={26}>
            <Node name="tests" vendor="deepseek" state={state(0)} progress={run} />
            <Node name="docs" vendor="ollama, local" state={state(1)} progress={run * 0.8} />
            <Node name="wire" vendor="kimi" state={state(2)} progress={run * 0.9} />
          </Row>
          {stage >= 3 ? (
            <>
              <Wires
                w={802}
                h={52}
                lines={[[677, 0, 677, 26], [401, 26, 677, 26], [401, 26, 401, 52]]}
                colour={theme.red}
              />
              <Node name="ship" vendor="depends_on: wire" state="skip" width={300} />
            </>
          ) : null}
          <div style={{ height: 28 }} />
          <Label colour={stage >= 3 ? theme.red : theme.cyan}>
            {stage >= 3 ? "one check failed, everything downstream is skipped" : "three vendors, at the same time"}
          </Label>
        </Col>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 4, 4)}>
        <Panel accent={theme.green} width={1000}>
          <Col gap={14}>
            <Head colour={theme.green}>One consolidated report</Head>
            <Kv k="core" v="pass - npm test -- ratelimit, exit 0" colour={theme.green} />
            <Kv k="tests" v="pass - npm test, exit 0" colour={theme.green} />
            <Kv k="docs" v="pass - no verification requested" colour={theme.green} />
            <Kv k="wire" v="fail - npm test, exit 1" colour={theme.red} />
            <Kv k="ship" v="skipped - depends_on: wire" colour={theme.faint} />
            <Label>every outcome recorded in the ledger</Label>
          </Col>
        </Panel>
      </Layer>
    </>
  );
};

const ReviewScene: React.FC<SceneProps> = ({ stage, stageProgress }) => (
  <>
    <Layer opacity={group(stage, stageProgress, 0, 1)}>
      <Row gap={38}>
        <Panel accent={theme.cyan} width={430}>
          <Col gap={12}>
            <Label colour={theme.cyan}>author</Label>
            <Head>deepseek-v4-pro</Head>
            <Kv k="diff" v="4 files, +212 -37" />
          </Col>
        </Panel>
        <Wires w={120} h={40} lines={arrow(120, 20)} colour={stage >= 1 ? theme.violet : theme.line} />
        <Panel accent={stage >= 1 ? theme.violet : theme.line} width={430}>
          <Col gap={12}>
            <Label colour={stage >= 1 ? theme.violet : theme.faint}>reviewer</Label>
            <Head>kimi-k2.7-code</Head>
            <Kv k="rule" v="never the same vendor" colour={theme.violet} />
          </Col>
        </Panel>
      </Row>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 2, 2)}>
      <Panel accent={theme.violet} width={980}>
        <Col gap={12}>
          <Label colour={theme.violet}>verdict</Label>
          {[
            ['"verdict": "revise",', theme.amber],
            ['"issues": [', theme.dim],
            ['  { "file": "src/ratelimit.ts", "line": 84,', theme.text],
            ['    "issue": "window resets on read, not on write" },', theme.text],
            ['  { "file": "src/server.ts", "line": 31,', theme.text],
            ['    "issue": "limiter bypassed for HEAD requests" }', theme.text],
            ["]", theme.dim],
          ].map(([t, c], i) => (
            <div
              key={i}
              style={{
                fontFamily: mono,
                fontSize: 22,
                color: c,
                opacity: interpolate(stageProgress, [i * 0.07, i * 0.07 + 0.15], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {t}
            </div>
          ))}
        </Col>
      </Panel>
    </Layer>

    <Layer opacity={group(stage, stageProgress, 3, 4)}>
      <Col gap={0} style={{ alignItems: "center" }}>
        <Row gap={22}>
          {[
            ["deepseek", "keep JSON files", theme.cyan],
            ["kimi", "move to SQLite", theme.violet],
            ["glm", "SQLite, behind a flag", theme.green],
          ].map(([name, take, colour]) => (
            <Panel key={name} accent={colour} width={300}>
              <Col gap={10}>
                <span style={{ fontFamily: mono, fontSize: 20, color: colour }}>{name}</span>
                <span style={{ fontFamily: sans, fontSize: 21, color: theme.text }}>{take}</span>
              </Col>
            </Panel>
          ))}
        </Row>
        <Wires w={944} h={56} lines={fanin(944, 56, [150, 472, 794])} colour={theme.faint} />
        <Panel accent={theme.text} width={880}>
          <Col gap={10}>
            <Label>judge</Label>
            <span style={{ fontFamily: sans, fontSize: 25, color: theme.text }}>
              Two of three favour SQLite; the disagreement is about migration cost, not correctness.
            </span>
            {stage >= 4 ? (
              <span style={{ fontFamily: mono, fontSize: 21, color: theme.green }}>
                you decide, with the disagreement in front of you
              </span>
            ) : null}
          </Col>
        </Panel>
      </Col>
    </Layer>
  </>
);

const LedgerScene: React.FC<SceneProps> = ({ stage, stageProgress }) => {
  const tree: [string, string, string][] = [
    [".break-free/", "", theme.green],
    ["  HANDOFF.md", "resume brief", theme.cyan],
    ["  PLAN.md", "board and dependency graph", theme.cyan],
    ["  tasks/T-014.md", "acceptance - verify - outcome", theme.cyan],
    ["  notes/routing.md", "decision: alias chains over per-call models", theme.cyan],
    ["  journal/2026-09.md", "what happened, in order", theme.cyan],
  ];
  return (
    <>
      <Layer opacity={group(stage, stageProgress, 0, 0)}>
        <Col gap={26} style={{ alignItems: "center" }}>
          <Panel accent={theme.line} width={900}>
            <Col gap={16}>
              <Row gap={16} style={{ justifyContent: "space-between" }}>
                <Label>session context</Label>
                <span style={{ fontFamily: mono, fontSize: 19, color: theme.red }}>full</span>
              </Row>
              <Bar progress={0.97} colour={theme.red} width={840} />
              <span style={{ fontFamily: sans, fontSize: 24, color: theme.dim }}>
                Everything the model learned today is about to be gone.
              </span>
            </Col>
          </Panel>
        </Col>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 1, 2)}>
        <Col gap={22} style={{ alignItems: "center" }}>
          <Panel accent={theme.green} width={1040}>
            <Col gap={12}>
              {tree.map(([k, v, c], i) => (
                <Row
                  key={k}
                  gap={22}
                  style={{
                    alignItems: "baseline",
                    opacity: interpolate(stageProgress, [i * 0.08, i * 0.08 + 0.18], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    }),
                  }}
                >
                  <span style={{ fontFamily: mono, fontSize: 22, color: c, width: 300 }}>{k}</span>
                  <span style={{ fontFamily: mono, fontSize: 19, color: theme.dim }}>{v}</span>
                </Row>
              ))}
            </Col>
          </Panel>
          {stage >= 2 ? (
            <Row gap={14}>
              <Chip colour={theme.green}>git commit</Chip>
              <Chip>reviewed in a pull request</Chip>
              <Chip colour={theme.violet}>opens as an Obsidian vault</Chip>
            </Row>
          ) : null}
        </Col>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 3, 3)}>
        <Row gap={36}>
          <Panel accent={theme.cyan} width={460}>
            <Col gap={12}>
              <Label colour={theme.cyan}>worker, next task</Label>
              <span style={{ fontFamily: sans, fontSize: 23, color: theme.text }}>
                receives the decisions and gotchas with its instructions
              </span>
            </Col>
          </Panel>
          <Panel accent={theme.amber} width={520}>
            <Col gap={10}>
              <Label colour={theme.amber}>gotcha</Label>
              <span style={{ fontFamily: mono, fontSize: 20, color: theme.text }}>
                Kimi rejects temperature above 1. Clamp before sending.
              </span>
              <span style={{ fontFamily: mono, fontSize: 18, color: theme.faint }}>
                found once, never rediscovered
              </span>
            </Col>
          </Panel>
        </Row>
      </Layer>

      <Layer opacity={group(stage, stageProgress, 4, 4)}>
        <Terminal title="claude code" width={1100}>
          <Row gap={12} style={{ alignItems: "baseline" }}>
            <span style={{ fontFamily: mono, fontSize: 23, color: theme.green }}>&gt;</span>
            <TypedLine text="/break-free-resume" reveal={Math.min(1, stageProgress * 3)} size={23} />
          </Row>
          <div style={{ height: 1, background: theme.line, margin: "10px 0" }} />
          {[
            ["in progress", "T-014 rate limiting - wire into src/server.ts", theme.cyan],
            ["blocked", "T-016 release - waiting on T-014", theme.amber],
            ["ready", "T-017 document the limiter", theme.green],
            ["last decision", "alias chains over per-call model pinning", theme.dim],
          ].map(([k, v, c], i) => (
            <Row
              key={k}
              gap={20}
              style={{
                alignItems: "baseline",
                opacity: interpolate(stageProgress, [0.25 + i * 0.1, 0.4 + i * 0.1], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              <span style={{ fontFamily: mono, fontSize: 19, color: c, width: 180 }}>{k}</span>
              <span style={{ fontFamily: mono, fontSize: 20, color: theme.text }}>{v}</span>
            </Row>
          ))}
        </Terminal>
      </Layer>
    </>
  );
};

export const scenes: Record<string, React.FC<SceneProps>> = {
  title: TitleScene,
  bottleneck: BottleneckScene,
  leadcrew: LeadCrewScene,
  verify: VerifyScene,
  install: InstallScene,
  delegate: DelegateScene,
  parallel: ParallelScene,
  review: ReviewScene,
  ledger: LedgerScene,
};

export const UnknownScene: React.FC<SceneProps> = () => (
  <Svg>
    <Flow d="M 300 540 L 1620 540" progress={1} dashed />
  </Svg>
);
