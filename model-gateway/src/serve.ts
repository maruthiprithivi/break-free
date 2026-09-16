/**
 * Local HTTP shim so Codex (which only speaks the OpenAI *Responses* API since
 * `wire_api = "chat"` was removed) can run on any provider the gateway knows,
 * even though DeepSeek, Kimi, Z.AI, MiniMax, OpenRouter, vLLM… only speak
 * chat/completions.
 *
 *   node dist/index.js --serve [port]          (default 18790, binds 127.0.0.1 only)
 *
 * Routes (provider = a name from list_providers; keys come from the gateway config,
 * the caller needs no key):
 *   POST /<provider>/v1/responses          Responses API → chat/completions (SSE streaming or JSON)
 *   POST /<provider>/v1/chat/completions   passthrough
 *   GET  /<provider>/v1/models             passthrough
 *   POST /v1/responses                     model must be "provider/model" or an alias (first usable candidate)
 *   GET  /healthz
 *
 * Codex config written by setup.mjs:
 *   [model_providers.break_free_deepseek]  base_url = "http://127.0.0.1:18790/deepseek/v1"  wire_api = "responses"
 */
import http from "node:http";
import type { GatewayConfig, ResolvedProvider } from "./config.js";
import { resolveProvider } from "./config.js";
import { resolveCandidates } from "./router.js";
import { classifyStatus } from "./client.js";
import { log as rlog } from "./logger.js";

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------ translation
interface ChatMsg { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }

export function responsesToChat(body: Record<string, unknown>): { messages: ChatMsg[]; tools?: unknown[]; extra: Record<string, unknown>; skipped: string[] } {
  const messages: ChatMsg[] = [];
  const skipped: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  const items: unknown[] = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : Array.isArray(input) ? input : [];
  const contentText = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c.map((p) => {
      const q = p as { type?: string; text?: string };
      if (q.type === "input_text" || q.type === "output_text" || q.type === "text") return q.text ?? "";
      if (q.type === "input_image" || q.type === "input_file") { skipped.push(q.type); return `[${q.type} omitted: not supported by this provider]`; }
      return q.text ?? "";
    }).join("");
  };
  for (const raw of items) {
    const it = raw as Record<string, unknown>;
    const type = String(it.type ?? "message");
    if (type === "message") {
      const role = it.role === "developer" ? "system" : String(it.role ?? "user");
      const text = contentText(it.content);
      if (role === "assistant") {
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && last.tool_calls && last.content === null) { last.content = text; continue; }
      }
      messages.push({ role, content: text });
    } else if (type === "function_call") {
      const call = { id: String(it.call_id ?? it.id ?? uid("call")), type: "function", function: { name: String(it.name ?? ""), arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) } };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (type === "function_call_output") {
      const out = it.output;
      messages.push({ role: "tool", tool_call_id: String(it.call_id ?? ""), content: typeof out === "string" ? out : JSON.stringify(out ?? "") });
    } else if (type === "reasoning" || type === "item_reference") {
      /* provider-internal; drop */
    } else {
      skipped.push(type);
    }
  }
  // Every tool message must follow an assistant message that declared the call; providers reject orphans.
  const declared = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => (c as { id: string }).id)));
  const clean = messages.filter((m) => m.role !== "tool" || declared.has(m.tool_call_id ?? ""));

  let tools: unknown[] | undefined;
  if (Array.isArray(body.tools)) {
    tools = [];
    for (const t of body.tools as Record<string, unknown>[]) {
      if (t.type === "function") tools.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } });
      else skipped.push(`tool:${String(t.type)}`);
    }
    if (!tools.length) tools = undefined;
  }
  const extra: Record<string, unknown> = {};
  if (typeof body.temperature === "number") extra.temperature = body.temperature;
  if (typeof body.top_p === "number") extra.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") extra.max_tokens = body.max_output_tokens;
  if (typeof body.parallel_tool_calls === "boolean" && tools) extra.parallel_tool_calls = body.parallel_tool_calls;
  const tc = body.tool_choice;
  if (tools && tc) {
    if (typeof tc === "string") extra.tool_choice = tc;
    else if (typeof tc === "object" && (tc as { type?: string }).type === "function") extra.tool_choice = { type: "function", function: { name: (tc as { name?: string }).name } };
  }
  return { messages: clean, tools, extra, skipped };
}

interface OutItem { type: "message" | "function_call" | "reasoning"; id: string; [k: string]: unknown }

function buildResponse(id: string, model: string, output: OutItem[], usage: Record<string, unknown> | undefined, status = "completed"): Record<string, unknown> {
  const u = (usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model, output,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0), input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 }, output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 } },
    parallel_tool_calls: true, tool_choice: "auto", store: false, error: null, incomplete_details: null,
  };
}

// ------------------------------------------------------------ upstream
function upstreamHeaders(p: ResolvedProvider): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...p.headers };
  if (p.apiKey) h.authorization = `Bearer ${p.apiKey}`;
  else if (!p.requiresKey) h.authorization = "Bearer local";
  return h;
}

/** Parse an SSE byte stream into JSON chunks. */
async function* sseJson(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m) continue;
        if (m[1].trim() === "[DONE]") return;
        try { yield JSON.parse(m[1]); } catch { /* ignore keepalives */ }
      }
    }
  }
}

// ------------------------------------------------------------ server
export function startServe(config: GatewayConfig, port: number, logLine: (s: string) => void): http.Server {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname === "/healthz") return send(200, { ok: true, providers: Object.keys(config.providers) });
      // /<provider>/v1/<rest>  or  /v1/<rest>
      const m = url.pathname.match(/^(?:\/([^/]+))?\/v1\/(responses|chat\/completions|models)$/);
      if (!m) return send(404, { error: { message: `no route for ${url.pathname}` } });
      const providerName = m[1];
      const route = m[2];
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: { message: "invalid JSON body" } }); }
      }
      // resolve provider + model
      let provider: ResolvedProvider | undefined;
      let model = String(body.model ?? "");
      if (providerName) provider = resolveProvider(config, providerName);
      else if (model) {
        const c = resolveCandidates(config, model).find((x) => !x.provider.unusableReason);
        if (c) { provider = c.provider; model = c.model; }
      }
      if (!provider) return send(404, { error: { message: providerName ? `unknown provider '${providerName}'` : `cannot resolve model '${model}'; use /<provider>/v1/... or model "provider/model"` } });
      if (provider.unusableReason) return send(401, { error: { message: `${provider.name}: ${provider.unusableReason}` } });
      if (!model) model = provider.defaultModel;

      if (route === "models") {
        const r = await fetch(`${provider.baseUrl}/models`, { headers: upstreamHeaders(provider) });
        res.writeHead(r.status, { "content-type": "application/json" });
        return res.end(await r.text());
      }
      if (route === "chat/completions") {
        const r = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: upstreamHeaders(provider), body: JSON.stringify({ ...body, model, ...(provider.extraBody ?? {}) }) });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        if (!r.body) return res.end();
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return res.end();
      }

      // ---- Responses API
      const { messages, tools, extra, skipped } = responsesToChat(body);
      const stream = body.stream === true;
      const upstreamBody: Record<string, unknown> = { model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(tools ? { tools } : {}), ...extra, ...(provider.extraBody ?? {}) };
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const r = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: upstreamHeaders(provider), body: JSON.stringify(upstreamBody), signal: ctrl.signal });
      if (!r.ok) {
        const text = await r.text();
        const reason = classifyStatus(r.status, text);
        rlog("route.attempt", { spec: `${provider.name}/${model}`, ok: false, reason, status: r.status, error: text.slice(0, 300), ms: Date.now() - started, via: "serve" });
        return send(r.status, { error: { message: `${provider.name}/${model}: HTTP ${r.status} ${text.slice(0, 600)}`, type: reason } });
      }
      const respId = uid("resp");
      const output: OutItem[] = [];
      let usage: Record<string, unknown> | undefined;

      if (!stream) {
        const j = (await r.json()) as { choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] } }[]; usage?: Record<string, unknown> };
        const msg = j.choices?.[0]?.message ?? {};
        if (msg.reasoning_content) output.push({ type: "reasoning", id: uid("rs"), summary: [{ type: "summary_text", text: msg.reasoning_content }] });
        if (msg.content) output.push({ type: "message", id: uid("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content, annotations: [] }] });
        for (const tc of msg.tool_calls ?? []) output.push({ type: "function_call", id: uid("fc"), call_id: tc.id ?? uid("call"), name: tc.function.name, arguments: tc.function.arguments ?? "{}", status: "completed" });
        usage = j.usage;
        rlog("route.attempt", { spec: `${provider.name}/${model}`, ok: true, ms: Date.now() - started, usage, via: "serve", skipped });
        return send(200, buildResponse(respId, model, output, usage));
      }

      // streaming: translate chat deltas into Responses SSE events
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let seq = 0;
      const emit = (type: string, data: Record<string, unknown>) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`); };
      const base = buildResponse(respId, model, [], undefined, "in_progress");
      emit("response.created", { response: base });
      emit("response.in_progress", { response: base });

      let msgItem: OutItem | undefined; let msgText = "";
      let rsItem: OutItem | undefined; let rsText = "";
      const calls = new Map<number, { item: OutItem; args: string }>();
      const closeMessage = () => {
        if (!msgItem) return;
        const idx = output.indexOf(msgItem);
        emit("response.output_text.done", { item_id: msgItem.id, output_index: idx, content_index: 0, text: msgText });
        emit("response.content_part.done", { item_id: msgItem.id, output_index: idx, content_index: 0, part: { type: "output_text", text: msgText, annotations: [] } });
        msgItem.content = [{ type: "output_text", text: msgText, annotations: [] }];
        msgItem.status = "completed";
        emit("response.output_item.done", { output_index: idx, item: msgItem });
        msgItem = undefined;
      };
      const closeReasoning = () => {
        if (!rsItem) return;
        const idx = output.indexOf(rsItem);
        emit("response.reasoning_summary_text.done", { item_id: rsItem.id, output_index: idx, summary_index: 0, text: rsText });
        rsItem.summary = [{ type: "summary_text", text: rsText }];
        emit("response.output_item.done", { output_index: idx, item: rsItem });
        rsItem = undefined;
      };
      let finish = "stop";
      for await (const chunk of sseJson(r)) {
        if (chunk.usage) usage = chunk.usage as Record<string, unknown>;
        const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined)?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        const reasoning = (d.reasoning_content ?? d.reasoning) as string | undefined;
        if (reasoning) {
          if (!rsItem) { rsItem = { type: "reasoning", id: uid("rs"), summary: [] }; output.push(rsItem); emit("response.output_item.added", { output_index: output.length - 1, item: rsItem }); emit("response.reasoning_summary_part.added", { item_id: rsItem.id, output_index: output.length - 1, summary_index: 0, part: { type: "summary_text", text: "" } }); }
          rsText += reasoning;
          emit("response.reasoning_summary_text.delta", { item_id: rsItem.id, output_index: output.indexOf(rsItem), summary_index: 0, delta: reasoning });
        }
        if (typeof d.content === "string" && d.content) {
          closeReasoning();
          if (!msgItem) { msgItem = { type: "message", id: uid("msg"), role: "assistant", status: "in_progress", content: [] }; output.push(msgItem); emit("response.output_item.added", { output_index: output.length - 1, item: msgItem }); emit("response.content_part.added", { item_id: msgItem.id, output_index: output.length - 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); }
          msgText += d.content;
          emit("response.output_text.delta", { item_id: msgItem.id, output_index: output.indexOf(msgItem), content_index: 0, delta: d.content });
        }
        if (Array.isArray(d.tool_calls)) {
          closeReasoning();
          closeMessage();
          for (const tc of d.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
            const idx = tc.index ?? 0;
            let entry = calls.get(idx);
            if (!entry) {
              const item: OutItem = { type: "function_call", id: uid("fc"), call_id: tc.id ?? uid("call"), name: tc.function?.name ?? "", arguments: "", status: "in_progress" };
              entry = { item, args: "" };
              calls.set(idx, entry);
              output.push(item);
              emit("response.output_item.added", { output_index: output.length - 1, item });
            } else if (tc.function?.name && !entry.item.name) entry.item.name = tc.function.name;
            if (tc.id && !entry.item.call_id) entry.item.call_id = tc.id;
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
              emit("response.function_call_arguments.delta", { item_id: entry.item.id, output_index: output.indexOf(entry.item), delta: tc.function.arguments });
            }
          }
        }
      }
      closeReasoning();
      closeMessage();
      for (const { item, args } of calls.values()) {
        item.arguments = args || "{}";
        item.status = "completed";
        const idx = output.indexOf(item);
        emit("response.function_call_arguments.done", { item_id: item.id, output_index: idx, arguments: item.arguments });
        emit("response.output_item.done", { output_index: idx, item });
      }
      const final = buildResponse(respId, model, output, usage, finish === "length" ? "incomplete" : "completed");
      if (finish === "length") final.incomplete_details = { reason: "max_output_tokens" };
      emit(finish === "length" ? "response.incomplete" : "response.completed", { response: final });
      res.end();
      rlog("route.attempt", { spec: `${provider.name}/${model}`, ok: true, ms: Date.now() - started, usage, via: "serve", stream: true, skipped, tool_calls: calls.size });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      logLine(`serve error: ${msg}`);
      rlog("route.attempt", { spec: "serve", ok: false, reason: "network", error: msg.slice(0, 300), ms: Date.now() - started, via: "serve" });
      if (!res.headersSent) send(502, { error: { message: msg } });
      else { try { res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message: msg })}\n\n`); } catch { /* ignore */ } res.end(); }
    }
  });
  server.listen(port, "127.0.0.1", () => logLine(`Responses-API shim listening on http://127.0.0.1:${port}  (routes: /<provider>/v1/responses, /<provider>/v1/chat/completions, /<provider>/v1/models, /healthz)`));
  return server;
}
