/**
 * Provider catalog. Every provider here speaks the OpenAI Chat Completions
 * dialect, so one HTTP client (client.ts) covers all of them. The catalog only
 * supplies sane defaults; everything is overridable from config.json or the
 * `configure_provider` MCP tool.
 */

export interface ProviderDefaults {
  /** Human readable name */
  label: string;
  /** Base URL up to (not including) /chat/completions */
  baseUrl: string;
  /** Env var the API key is read from when config has no apiKey */
  keyEnv: string;
  /** Whether a key is needed at all (local Ollama: no) */
  requiresKey: boolean;
  /**
   * What this endpoint is for. `chat` providers speak the OpenAI Chat Completions
   * dialect and may be selected for any delegate/run_plan task. `decision` providers
   * answer typed questions (TypeSafe System One) and are NEVER reachable from chat
   * routing — they have their own client (jev.ts) and their own lane in run_plan.
   */
  kind?: "chat" | "decision";
  /** Extra headers to send on every request */
  headers?: Record<string, string>;
  /** Default model used when a bare provider name is requested */
  defaultModel: string;
  /** Known models (documentation only; any model string is accepted) */
  knownModels: string[];
  /** Does the endpoint support OpenAI-style function/tool calling? */
  supportsTools: boolean;
  /** Merged into every request body after the caller's fields (provider quirks, e.g. fixed temperature) */
  extraBody?: Record<string, unknown>;
  /** Where to get a key */
  docs: string;
  notes?: string;
}

export const PROVIDER_CATALOG: Record<string, ProviderDefaults> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    requiresKey: true,
    defaultModel: "deepseek-v4-flash",
    knownModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    supportsTools: true,
    docs: "https://platform.deepseek.com/api_keys",
    notes: "Reasoning content (reasoning_content) is stripped from replies; thinking can be enabled via extra body {\"thinking\":{\"type\":\"enabled\"}}.",
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "OLLAMA_API_KEY",
    requiresKey: false,
    defaultModel: "qwen3-coder:30b",
    knownModels: ["qwen3-coder:30b", "qwen3:8b", "gpt-oss:20b", "deepseek-r1:14b", "devstral:24b"],
    supportsTools: true,
    docs: "https://docs.ollama.com/api/openai-compatibility",
    notes: "Key is optional locally. Use model names exactly as `ollama list` prints them. Cloud-backed models pulled locally end in `-cloud`.",
  },
  "ollama-cloud": {
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    keyEnv: "OLLAMA_API_KEY",
    requiresKey: true,
    defaultModel: "gpt-oss:120b",
    knownModels: ["gpt-oss:120b", "deepseek-v4-flash", "qwen3.5:397b", "gemma4:31b", "mistral-large-3:675b"],
    supportsTools: true,
    docs: "https://ollama.com/settings/keys",
  },
  kimi: {
    label: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: "MOONSHOT_API_KEY",
    requiresKey: true,
    defaultModel: "kimi-k2.7-code",
    knownModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
    supportsTools: true,
    extraBody: { temperature: 1 },
    docs: "https://platform.kimi.ai/",
    notes: "Kimi code models accept only temperature=1; the catalog pins it (override via providers.kimi.extraBody).",
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    keyEnv: "MINIMAX_API_KEY",
    requiresKey: true,
    defaultModel: "MiniMax-M2.7",
    knownModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"],
    supportsTools: true,
    docs: "https://platform.minimax.io/",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    requiresKey: true,
    defaultModel: "gemini-3.1-pro-preview",
    knownModels: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    supportsTools: true,
    docs: "https://aistudio.google.com/apikey",
    notes:
      "Google's OpenAI-compatibility layer, so the same client works: model ids are the bare names (`gemini-3.1-pro-preview`), not the `models/`-prefixed ids the native API lists. " +
      "The `gemini-2.5-*` ids are retired for new accounts (404). The pro and `-latest` tiers are reasoning models that spend output tokens thinking BEFORE answering, so a small `max_tokens` returns empty content with `finish_reason: length` — tools still work, the budget just ran out first. " +
      "`bf bench route` uses this provider for the frontier-LLM-as-router baseline (criterion 11).",
  },
  zai: {
    label: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    requiresKey: true,
    defaultModel: "glm-5.3",
    knownModels: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5"],
    supportsTools: true,
    docs: "https://z.ai/manage-apikey/apikey-list",
    notes: "Coding-plan subscribers use baseUrl https://api.z.ai/api/coding/paas/v4 instead.",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    requiresKey: true,
    headers: { "HTTP-Referer": "https://github.com/model-gateway-mcp", "X-Title": "model-gateway-mcp" },
    defaultModel: "deepseek/deepseek-v4-flash",
    knownModels: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "moonshotai/kimi-k3", "z-ai/glm-5.3", "minimax/minimax-m3", "qwen/qwen3-coder"],
    supportsTools: true,
    docs: "https://openrouter.ai/keys",
    notes: "Model ids contain a slash: request them as openrouter/<vendor>/<model>.",
  },
  opencode: {
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyEnv: "OPENCODE_API_KEY",
    requiresKey: true,
    defaultModel: "deepseek-v4-flash",
    knownModels: ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "kimi-k2.7-code", "glm-5.3", "minimax-m3", "big-pickle"],
    supportsTools: true,
    docs: "https://opencode.ai/zen",
  },
  vllm: {
    label: "vLLM / any OpenAI-compatible server",
    baseUrl: "http://localhost:8000/v1",
    keyEnv: "VLLM_API_KEY",
    requiresKey: false,
    defaultModel: "default",
    knownModels: [],
    supportsTools: true,
    docs: "https://docs.vllm.ai/",
    notes: "Generic slot: point baseUrl at LM Studio, llama.cpp server, LiteLLM, Groq, etc.",
  },
  typesafe: {
    label: "TypeSafe (Jev) — decision routing",
    baseUrl: "https://api.typesafe.ai/v1",
    keyEnv: "TYPESAFE_API_KEY",
    requiresKey: true,
    kind: "decision",
    defaultModel: "jev-latest",
    knownModels: ["jev-latest", "jev-preview", "jev-1.13.0"],
    supportsTools: false,
    docs: "https://console.typesafe.ai/settings/keys",
    notes:
      "NOT OpenAI-compatible and NEVER used for chat: POST /v1/systemone answers typed questions (Choice/Score/Noul) against a state. " +
      "`routing.engine: jev` uses it to pick a lane per run_plan task. Input $0.042/Mtok, output free, 429/529 on overload. " +
      "Pin a version (jev-1.13.0) if you tune `routing.threshold` against a specific release.",
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDER_CATALOG);

/**
 * Is this endpoint on the machine or the local network? Used by `configure_provider` to default
 * `requiresKey` to false: a local inference server (Ollama, LM Studio, llama.cpp, vLLM) almost never
 * wants auth, and asking for a key it will ignore made the documented one-call path impossible —
 * the only way to finish was to hand-edit `requiresKey` into the config (#13).
 *
 * Deliberately conservative: a public FQDN is never local, however it is spelled. A single-label
 * host (`http://optimus:11435/v1`) is local because a public name cannot resolve without a dot.
 */
export function isLocalEndpoint(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false; // unparseable URL: not evidence of a local endpoint, and no default to justify
  }
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true; // IPv6 unique-local / link-local
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return !host.includes(".");
}
