// Mock OpenAI-compatible provider used by the test-suite and by `npm run demo`.
// Behaviour is keyed on the model name so tests can exercise fallback, tools, auth.
import http from "node:http";

export function startMockProvider({ apiKey = "test-key", port = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith("/models")) return send(200, { data: [{ id: "good" }, { id: "tooly" }, { id: "flaky429" }] });
      // Anthropic Messages API compatibility (what Claude Code speaks)
      if (req.url.endsWith("/v1/messages")) {
        if (req.headers["x-api-key"] !== apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        const j = JSON.parse(body);
        if (j.model === "nomodel") return send(404, { type: "error", error: { type: "not_found_error", message: "model not found" } });
        return send(200, { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
      }
      if (!req.url.endsWith("/chat/completions")) return send(404, { error: { message: "not found" } });
      if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: { message: "invalid api key" } });
      const j = JSON.parse(body);
      calls.push(j);
      const { model, messages, tools } = j;
      const last = messages[messages.length - 1];
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const reply = (content, extra = {}) => {
        if (!j.stream) return send(200, { id: "cmpl-1", choices: [{ index: 0, finish_reason: extra.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content, ...extra } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        // SSE stream: reasoning, then content in 2 chunks, then tool calls (arguments split), then usage
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o) => res.write(`data: ${JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, delta: o.delta ?? {}, finish_reason: o.finish ?? null }], ...(o.usage ? { usage: o.usage } : {}) })}\n\n`);
        if (model === "thinker") ev({ delta: { reasoning_content: "let me think" } });
        if (content) { const h = Math.ceil(content.length / 2); ev({ delta: { content: content.slice(0, h) } }); ev({ delta: { content: content.slice(h) } }); }
        for (const [i, tc] of (extra.tool_calls ?? []).entries()) {
          const a = tc.function.arguments; const h = Math.ceil(a.length / 2);
          ev({ delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: a.slice(0, h) } }] } });
          ev({ delta: { tool_calls: [{ index: i, function: { arguments: a.slice(h) } }] } });
        }
        ev({ delta: {}, finish: extra.tool_calls ? "tool_calls" : "stop" });
        ev({ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (model === "flaky429") return send(429, { error: { message: "rate limited" } });
      if (model === "boom500") return send(500, { error: { message: "upstream exploded" } });
      if (model === "nomodel") return send(404, { error: { message: "model not found" } });
      if (model === "slow") return setTimeout(() => reply("late"), 3000);
      if (model === "thinker") return reply("thought done");
      // Responses-shim test: echo the transcript shape so the test can assert the translation
      if (model === "shape") return reply(JSON.stringify({ roles: messages.map((m) => m.role), tools: (tools ?? []).map((t) => t.function.name), tool_msgs: messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), extra: { temperature: j.temperature, max_tokens: j.max_tokens, tool_choice: j.tool_choice } }));

      // The frontier-LLM-as-router baseline answers with one lane per task id from the state it was
      // handed. Alternating local/strong, so a test asserts the ARM's plumbing, not a model's mood.
      if (/You route software engineering subtasks/.test(system)) {
        let ids = [];
        try { ids = (JSON.parse(last.content)?.tasks ?? []).map((t) => t.id); } catch { /* empty */ }
        return reply(JSON.stringify(ids.map((id, i) => ({ id, lane: i % 2 === 1 ? "strong" : "local" }))));
      }

      // Reviewer / supervisor personas answer with JSON.
      if (/independent, skeptical code reviewer/.test(system)) {
        return reply(JSON.stringify({ verdict: "revise", confidence: 0.8, summary: "mock review", issues: [{ severity: "major", file: "src/app.js", line: 1, title: "no tests", detail: "no tests", suggestion: "add tests" }], strengths: [], questions: [] }));
      }
      if (/supervisor of a delegated engineer/.test(system)) {
        const round = (last.content.match(/Round (\d+)/) ?? [])[1];
        return reply(JSON.stringify(round === "1" ? { decision: "revise", confidence: 0.5, assessment: "needs work", feedback_for_worker: "1. add a comment", issues: [] } : { decision: "accept", confidence: 0.9, assessment: "fine", feedback_for_worker: "", issues: [] }));
      }
      if (/judge of a panel/.test(system)) return reply("## Consensus\nall good\n## Best answer\n42");

      // Tool-using worker: first turn calls a tool named in the prompt, second turn summarises.
      if (model === "tooly" && tools?.length) {
        if (last.role === "tool") return reply(`TOOL RESULT WAS:\n${last.content}`);
        const m = last.content.match(/CALL (\w+) (\{.*\})/s);
        if (m) return reply(null, { tool_calls: [{ id: "call_1", type: "function", function: { name: m[1], arguments: m[2] } }] });
      }
      return reply(`echo(${model}): ${last.content.slice(0, 200)}`);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, calls, close: () => new Promise((r) => server.close(r)) }));
  });
}

if (process.argv[1] && process.argv[1].endsWith("mock-provider.mjs")) {
  const { port } = await startMockProvider({ port: Number(process.env.PORT ?? 8787) });
  console.log(`mock provider on http://127.0.0.1:${port}/v1  (key: test-key; models: good, tooly, flaky429, boom500, nomodel, slow)`);
}
