#!/usr/bin/env node
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 2169);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.3-codex";
const COPILOT_BASE_URL = (process.env.COPILOT_BASE_URL || "https://api.githubcopilot.com").replace(/\/$/, "");
const COPILOT_CHAT_PATH = process.env.COPILOT_CHAT_PATH || "/chat/completions";
const COPILOT_MESSAGES_PATH = process.env.COPILOT_MESSAGES_PATH || "/v1/messages";
const COPILOT_RESPONSES_PATH = process.env.COPILOT_RESPONSES_PATH || "/responses";
const COPILOT_MODELS_PATH = process.env.COPILOT_MODELS_PATH || "/models";
const COPILOT_ANTHROPIC_VERSION = process.env.COPILOT_ANTHROPIC_VERSION || "2023-06-01";
const COPILOT_BETA_HEADER = process.env.COPILOT_BETA_HEADER || "";
const MODEL_ENDPOINT_CACHE_TTL_MS = Number(process.env.MODEL_ENDPOINT_CACHE_TTL_MS || 60000);
function compileOptionalRegex(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  return new RegExp(raw, "i");
}

const FORCE_MESSAGES_MODEL_REGEX = compileOptionalRegex(process.env.FORCE_MESSAGES_MODEL_REGEX);
const FORCE_RESPONSES_MODEL_REGEX = compileOptionalRegex(
  process.env.FORCE_RESPONSES_MODEL_REGEX || "(codex|^gpt-5(?:\\.|-))"
);
const FORCE_AGENT_MODEL_REGEX = compileOptionalRegex(process.env.FORCE_AGENT_MODEL_REGEX || "(codex)");
const DEFAULT_RESPONSES_TOOL_CHOICE_WITH_TOOLS =
  process.env.DEFAULT_RESPONSES_TOOL_CHOICE_WITH_TOOLS || "required";
const DEFAULT_RESPONSES_REASONING_EFFORT = process.env.DEFAULT_RESPONSES_REASONING_EFFORT || "high";
const DEFAULT_RESPONSES_TEXT_VERBOSITY = process.env.DEFAULT_RESPONSES_TEXT_VERBOSITY || "high";
const COPILOT_EDITOR_VERSION = process.env.COPILOT_EDITOR_VERSION || "vscode/1.116.0";
const COPILOT_EDITOR_PLUGIN_VERSION = process.env.COPILOT_EDITOR_PLUGIN_VERSION || "copilot-chat/0.44.1";
const COPILOT_INTEGRATION_ID = process.env.COPILOT_INTEGRATION_ID || "vscode-chat";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_API_KEY_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_COPILOT_OAUTH_CLIENT_ID = process.env.GITHUB_COPILOT_OAUTH_CLIENT_ID || "Iv1.b507a08c87ecfe98";
const ADMIN_MODEL_ALLOWLIST = (process.env.ADMIN_MODEL_ALLOWLIST || "gpt-5.3-codex,gpt-5.4-mini,gemini-3.1-pro-preview")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_RECOMMENDED_MODEL = process.env.ADMIN_RECOMMENDED_MODEL || "gpt-5.3-codex";
const COPILOT_ACCESS_TOKEN = process.env.COPILOT_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
const COPILOT_TOKEN_DIR = process.env.COPILOT_TOKEN_DIR || path.join(os.homedir(), ".config", "copilot-claude-proxy", "copilot");
const COPILOT_OAUTH_ACCESS_TOKEN_FILE = path.join(COPILOT_TOKEN_DIR, "access-token");
const COPILOT_API_KEY_FILE = path.join(COPILOT_TOKEN_DIR, "api-key.json");
const CLAUDE_SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_PROXY_STATE_PATH =
  process.env.CLAUDE_PROXY_STATE_PATH || path.join(os.homedir(), ".claude", "github-proxy-state.json");
const CLAUDE_PROXY_API_KEY = process.env.CLAUDE_PROXY_API_KEY || "local-bridge-key";

const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL"
];

let modelEndpointCache = {
  expiresAt: 0,
  map: new Map()
};

let copilotModelsCache = {
  expiresAt: 0,
  rows: []
};

let lastBridgeTrace = {
  at: null,
  model: null,
  mode: null,
  stream: null,
  request_tools_count: 0,
  request_tool_choice: null,
  response_tool_use_count: 0,
  response_text_chars: 0,
  note: "no requests yet"
};

let liveBridgeState = {
  active: false,
  request_id: null,
  model: null,
  mode: null,
  stream: null,
  started_at: null,
  last_event_at: null,
  last_event_type: null,
  events_seen: 0,
  error: null,
  completed_at: null,
  duration_ms: null,
  note: "idle"
};

let runtimeCopilotToken = COPILOT_ACCESS_TOKEN || null;
let runtimeCopilotTokenExpiresAt = null;
let runtimeCopilotApiBase = null;
let runtimeCopilotTokenSource = COPILOT_ACCESS_TOKEN ? "env" : null;
let pendingDeviceCode = null;

function getCopilotApiBase() {
  return runtimeCopilotApiBase || COPILOT_BASE_URL;
}

const ARG_STREAM_STALL_EVENT_THRESHOLD = Number(process.env.ARG_STREAM_STALL_EVENT_THRESHOLD || 600);
const ARG_STREAM_STALL_RETRY_LIMIT = Number(process.env.ARG_STREAM_STALL_RETRY_LIMIT || 1);

function setLastBridgeTrace(patch) {
  lastBridgeTrace = {
    ...lastBridgeTrace,
    ...patch,
    at: new Date().toISOString()
  };
}

function startLiveBridgeState({ requestId, model, mode, stream }) {
  liveBridgeState = {
    active: true,
    request_id: requestId,
    model,
    mode,
    stream,
    started_at: new Date().toISOString(),
    last_event_at: null,
    last_event_type: null,
    events_seen: 0,
    error: null,
    completed_at: null,
    duration_ms: null,
    note: "started"
  };
}

function markLiveBridgeEvent(eventType) {
  if (!liveBridgeState.active) {
    return;
  }

  liveBridgeState = {
    ...liveBridgeState,
    last_event_at: new Date().toISOString(),
    last_event_type: eventType,
    events_seen: Number(liveBridgeState.events_seen || 0) + 1,
    note: "streaming"
  };
}

function endLiveBridgeState({ note, error } = {}) {
  const nowIso = new Date().toISOString();
  const started = liveBridgeState.started_at ? Date.parse(liveBridgeState.started_at) : null;
  const ended = Date.parse(nowIso);
  const durationMs = started ? Math.max(0, ended - started) : null;

  liveBridgeState = {
    ...liveBridgeState,
    active: false,
    completed_at: nowIso,
    duration_ms: durationMs,
    error: error || null,
    note: note || (error ? "error" : "completed")
  };
}



function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function anthropicSystemToText(system) {
  if (!system) {
    return "";
  }
  if (typeof system === "string") {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && item.type === "text") {
          return String(item.text || "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text") {
        return String(block.text || "");
      }
      if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          return block.content;
        }
        if (Array.isArray(block.content)) {
          return block.content
            .map((c) => (c && c.type === "text" ? String(c.text || "") : ""))
            .filter(Boolean)
            .join("\n");
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicMessagesToOpenAiMessages(payload) {
  const out = [];
  const systemText = anthropicSystemToText(payload.system);

  if (systemText) {
    out.push({ role: "system", content: systemText });
  }

  for (const msg of payload.messages || []) {
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (!Array.isArray(content)) {
      out.push({ role, content: typeof content === "string" ? content : "" });
      continue;
    }

    const toolUseBlocks = role === "assistant" ? content.filter((b) => b?.type === "tool_use") : [];

    if (role === "assistant" && toolUseBlocks.length > 0) {
      const text = normalizeTextContent(content);
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id || createId("call"),
          type: "function",
          function: {
            name: String(b.name || "tool"),
            arguments: JSON.stringify(b.input || {})
          }
        }))
      });
      continue;
    }

    if (role === "user") {
      const toolResults = content.filter((b) => b?.type === "tool_result");
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.tool_use_id || createId("call"),
            content: normalizeTextContent([tr]) || ""
          });
        }

        const nonToolResult = content.filter((b) => b?.type !== "tool_result");
        const text = normalizeTextContent(nonToolResult);
        if (text) {
          out.push({ role: "user", content: text });
        }
        continue;
      }
    }

    out.push({ role, content: normalizeTextContent(content) });
  }

  return out;
}

function anthropicMessagesToResponsesInput(payload) {
  const input = [];

  for (const msg of payload.messages || []) {
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (role === "assistant" && Array.isArray(content)) {
      const toolUses = content.filter((b) => b?.type === "tool_use");
      const nonToolUse = content.filter((b) => b?.type !== "tool_use");
      const text = normalizeTextContent(nonToolUse);

      if (text) {
        input.push({ role: "assistant", content: text });
      }

      for (const tu of toolUses) {
        input.push({
          type: "function_call",
          call_id: String(tu?.id || createId("call")),
          name: String(tu?.name || "tool"),
          arguments: JSON.stringify(tu?.input || {})
        });
      }

      if (toolUses.length > 0) {
        continue;
      }
    }

    if (role === "user" && Array.isArray(content)) {
      const toolResults = content.filter((b) => b?.type === "tool_result");
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          input.push({
            type: "function_call_output",
            call_id: tr.tool_use_id || createId("call"),
            output: normalizeTextContent([tr]) || ""
          });
        }

        const nonToolResult = content.filter((b) => b?.type !== "tool_result");
        const text = normalizeTextContent(nonToolResult);
        if (text) {
          input.push({ role: "user", content: text });
        }

        continue;
      }
    }

    const text = typeof content === "string" ? content : normalizeTextContent(content);
    input.push({ role, content: text || "" });
  }

  return input;
}

function mapTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }
  }));
}

function mapToolsForResponses(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools
    .filter((tool) => tool && typeof tool === "object")
    .map((tool) => ({
      type: "function",
      name: String(tool.name || "tool"),
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }));
}

function mapToolChoice(choice) {
  if (!choice) {
    return undefined;
  }

  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") {
      return choice;
    }
    return undefined;
  }

  if (choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool" && choice.name) {
    return {
      type: "function",
      name: choice.name
    };
  }
  return undefined;
}

function mapToolChoiceForResponses(choice) {
  if (!choice) {
    return undefined;
  }

  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") {
      return choice;
    }
    return undefined;
  }

  if (choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool" && choice.name) {
    return {
      type: "function",
      name: choice.name
    };
  }
  return undefined;
}

function extractToolSchemaShape(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return null;
  }
  const first = tools[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  if (first.function && typeof first.function === "object") {
    return "nested";
  }
  if (first.type === "function" && typeof first.name === "string") {
    return "flat";
  }
  return null;
}

function buildOpenAiRequest(payload) {
  const model = payload.model || DEFAULT_MODEL;
  const stream = Boolean(payload.stream);

  return {
    model,
    stream,
    messages: anthropicMessagesToOpenAiMessages(payload),
    max_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stop: payload.stop_sequences,
    tools: mapTools(payload.tools),
    tool_choice: mapToolChoice(payload.tool_choice)
  };
}

function buildCopilotHeaders(extraHeaders = {}) {
  const token = runtimeCopilotToken || COPILOT_ACCESS_TOKEN;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "GithubCopilot/1.155.0",
    "editor-version": COPILOT_EDITOR_VERSION,
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
    ...extraHeaders
  };

  if (COPILOT_BETA_HEADER) {
    headers["anthropic-beta"] = COPILOT_BETA_HEADER;
  }

  return headers;
}

function resolveCopilotInitiator(model, payload) {
  if (FORCE_AGENT_MODEL_REGEX?.test(model)) {
    return "agent";
  }

  const hasTools = Array.isArray(payload?.tools) && payload.tools.length > 0;
  if (hasTools) {
    return "agent";
  }

  const hasAssistantOrToolHistory = Array.isArray(payload?.messages)
    ? payload.messages.some((m) => m?.role === "assistant" || m?.role === "tool")
    : false;

  return hasAssistantOrToolHistory ? "agent" : "user";
}

async function getCopilotModelEndpointMap() {
  const now = Date.now();
  if (now < modelEndpointCache.expiresAt) {
    return modelEndpointCache.map;
  }

  try {
    const response = await fetch(`${getCopilotApiBase()}${COPILOT_MODELS_PATH}`, {
      headers: buildCopilotHeaders()
    });

    if (!response.ok) {
      return modelEndpointCache.map;
    }

    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const map = new Map();

    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const id = String(row.id || "");
      const endpoints = Array.isArray(row.supported_endpoints) ? row.supported_endpoints.map(String) : [];
      if (id) {
        map.set(id, endpoints);
      }
    }

    modelEndpointCache = {
      expiresAt: now + MODEL_ENDPOINT_CACHE_TTL_MS,
      map
    };
  } catch {
    return modelEndpointCache.map;
  }

  return modelEndpointCache.map;
}

async function getCopilotModels() {
  const now = Date.now();
  if (now < copilotModelsCache.expiresAt) {
    return copilotModelsCache.rows;
  }

  try {
    const response = await fetch(`${getCopilotApiBase()}${COPILOT_MODELS_PATH}`, {
      headers: buildCopilotHeaders()
    });

    if (!response.ok) {
      return copilotModelsCache.rows;
    }

    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    copilotModelsCache = {
      expiresAt: now + MODEL_ENDPOINT_CACHE_TTL_MS,
      rows
    };
    return rows;
  } catch {
    return copilotModelsCache.rows;
  }
}

async function resolveUpstreamMode(model) {
  const endpointMap = await getCopilotModelEndpointMap();
  const endpoints = endpointMap.get(model) || [];
  if (endpoints.includes("/responses")) {
    return "responses";
  }
  if (endpoints.includes("/chat/completions")) {
    return "chat";
  }
  if (endpoints.includes("/v1/messages")) {
    return "messages";
  }
  if (FORCE_RESPONSES_MODEL_REGEX?.test(model)) {
    return "responses";
  }
  if (FORCE_MESSAGES_MODEL_REGEX?.test(model)) {
    return "messages";
  }
  return "chat";
}

function buildResponsesRequest(payload) {
  const model = payload.model || DEFAULT_MODEL;
  const instructions = anthropicSystemToText(payload.system) || undefined;
  const tools = mapToolsForResponses(payload.tools);
  const mappedToolChoice = mapToolChoiceForResponses(payload.tool_choice);
  const inferredToolChoice =
    Array.isArray(tools) && tools.length > 0
      ? tools.length > 8
        ? "auto"
        : DEFAULT_RESPONSES_TOOL_CHOICE_WITH_TOOLS
      : undefined;
  const toolChoice = mappedToolChoice || inferredToolChoice;

  return {
    model,
    stream: Boolean(payload.stream),
    input: anthropicMessagesToResponsesInput(payload),
    instructions,
    max_output_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    reasoning: {
      effort: DEFAULT_RESPONSES_REASONING_EFFORT
    },
    text: {
      verbosity: DEFAULT_RESPONSES_TEXT_VERBOSITY
    },
    tools,
    tool_choice: toolChoice
  };
}

function stringifyFunctionArguments(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function isFunctionCallItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (item.type === "function_call") {
    return true;
  }
  return Boolean(item.function && typeof item.function === "object");
}

function functionCallNameFromItem(item) {
  if (typeof item?.name === "string" && item.name) {
    return item.name;
  }
  if (typeof item?.function?.name === "string" && item.function.name) {
    return item.function.name;
  }
  return "tool";
}

function functionCallArgumentsFromItem(item) {
  if (item && Object.prototype.hasOwnProperty.call(item, "arguments")) {
    return item.arguments;
  }
  if (item?.function && Object.prototype.hasOwnProperty.call(item.function, "arguments")) {
    return item.function.arguments;
  }
  return undefined;
}

function normalizeToolInput(toolName, input) {
  let next = input && typeof input === "object" ? { ...input } : {};

  if (next.input && typeof next.input === "object" && Object.keys(next).length === 1) {
    next = { ...next.input };
  }

  if (next.arguments !== undefined && Object.keys(next).length === 1) {
    const args = next.arguments;
    if (args && typeof args === "object") {
      next = { ...args };
    } else if (typeof args === "string") {
      next = parseJsonLoose(args, { raw: args });
    }
  }

  if (next.params && typeof next.params === "object" && Object.keys(next).length === 1) {
    next = { ...next.params };
  }

  if (toolName === "Task") {
    const hasDescription = typeof next.description === "string" && next.description.trim().length > 0;
    const hasPrompt = typeof next.prompt === "string" && next.prompt.trim().length > 0;
    if (!hasDescription && hasPrompt) {
      next.description = next.prompt.slice(0, 140);
    }
    if (!hasPrompt && hasDescription) {
      next.prompt = next.description;
    }
  }

  return next;
}

function textFromResponsesOutput(upstream) {
  if (typeof upstream?.output_text === "string" && upstream.output_text) {
    return upstream.output_text;
  }

  const output = Array.isArray(upstream?.output) ? upstream.output : [];
  const parts = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text) {
        parts.push(c.text);
      }
    }
  }

  return parts.join("\n");
}

function responsesOutputHasRefusal(upstream) {
  const output = Array.isArray(upstream?.output) ? upstream.output : [];
  for (const item of output) {
    if (item?.type === "refusal") {
      return true;
    }

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "refusal") {
        return true;
      }
    }
  }
  return false;
}

function toolUsesFromResponsesOutput(upstream) {
  const output = Array.isArray(upstream?.output) ? upstream.output : [];
  return output
    .filter((item) => isFunctionCallItem(item))
    .map((item) => {
      let parsedInput = {};
      const rawArgs = functionCallArgumentsFromItem(item);
      if (rawArgs && typeof rawArgs === "object") {
        parsedInput = rawArgs;
      } else {
        const argsText = stringifyFunctionArguments(rawArgs);
        if (argsText) {
          try {
            parsedInput = JSON.parse(argsText);
          } catch {
            parsedInput = { raw: argsText };
          }
        }
      }

      return {
        type: "tool_use",
        id: String(item?.call_id || item?.id || createId("toolu")),
        name: String(functionCallNameFromItem(item) || "tool"),
        input: normalizeToolInput(String(functionCallNameFromItem(item) || "tool"), parsedInput)
      };
    });
}

function buildAnthropicResponseFromResponses(upstream, model) {
  const text = textFromResponsesOutput(upstream);
  const toolBlocks = toolUsesFromResponsesOutput(upstream);
  const hasRefusal = responsesOutputHasRefusal(upstream);
  const inputTokens = Number(upstream?.usage?.input_tokens || upstream?.usage?.prompt_tokens || 0);
  const outputTokens = Number(upstream?.usage?.output_tokens || upstream?.usage?.completion_tokens || 0);
  const content = [];

  if (text) {
    content.push({ type: "text", text });
  }
  content.push(...toolBlocks);

  return {
    id: createId("msg"),
    type: "message",
    role: "assistant",
    model: upstream?.model || model || "unknown",
    content,
    stop_reason: hasRefusal ? "refusal" : toolBlocks.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

function cleanUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function parseJsonLoose(text, fallbackValue = {}) {
  try {
    return text ? JSON.parse(text) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

async function readUpstreamJsonResponse(response) {
  const rawText = await response.text();
  const parsed = parseJsonLoose(rawText, { raw: rawText });
  return {
    rawText,
    parsed
  };
}

function getUpstreamErrorMessage(parsed, rawText, fallbackMessage = "Upstream request failed") {
  return parsed?.error?.message || rawText || fallbackMessage;
}

async function ensureCopilotTokenDir() {
  await fs.mkdir(COPILOT_TOKEN_DIR, { recursive: true });
}

function githubApiHeaders(accessToken) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "editor-version": COPILOT_EDITOR_VERSION,
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "user-agent": "GithubCopilot/1.155.0",
    "accept-encoding": "gzip,deflate,br",
    authorization: `token ${accessToken}`
  };
}

async function loadSavedCopilotApiKeyInfo() {
  const fallback = null;
  const info = await readJsonFileSafe(COPILOT_API_KEY_FILE, fallback);
  if (!info || typeof info !== "object") {
    return null;
  }
  return info;
}

async function loadSavedCopilotOAuthAccessToken() {
  try {
    const token = (await fs.readFile(COPILOT_OAUTH_ACCESS_TOKEN_FILE, "utf-8")).trim();
    return token || null;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveCopilotOAuthAccessToken(token) {
  await ensureCopilotTokenDir();
  await fs.writeFile(COPILOT_OAUTH_ACCESS_TOKEN_FILE, token, "utf-8");
}

async function saveCopilotApiKeyInfo(info) {
  await ensureCopilotTokenDir();
  await writeJsonFile(COPILOT_API_KEY_FILE, info);
}

function applyRuntimeTokenInfo(tokenInfo) {
  runtimeCopilotToken = tokenInfo?.token || runtimeCopilotToken;
  runtimeCopilotTokenExpiresAt = tokenInfo?.expires_at || null;
  runtimeCopilotApiBase = tokenInfo?.endpoints?.api || null;
  runtimeCopilotTokenSource = "copilot_internal_api_key";
}

function isRuntimeTokenFresh() {
  if (!runtimeCopilotToken) {
    return false;
  }
  if (!runtimeCopilotTokenExpiresAt) {
    return true;
  }
  return Number(runtimeCopilotTokenExpiresAt) > Math.floor(Date.now() / 1000) + 30;
}

async function exchangeGithubAccessForCopilotApiKey(accessToken) {
  const response = await fetch(GITHUB_COPILOT_API_KEY_URL, {
    method: "GET",
    headers: githubApiHeaders(accessToken)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    throw new Error(parsed?.message || parsed?.error || text || "Failed to fetch Copilot API key");
  }

  if (!parsed?.token) {
    throw new Error("Copilot API key response missing token");
  }

  await saveCopilotApiKeyInfo(parsed);
  applyRuntimeTokenInfo(parsed);
  return parsed;
}

async function ensureCopilotAuthReady() {
  const runtimeIsFresh = isRuntimeTokenFresh();
  if (runtimeIsFresh && runtimeCopilotTokenSource !== "env") {
    return {
      token: runtimeCopilotToken,
      source: runtimeCopilotTokenSource,
      apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
    };
  }

  const savedApiKey = await loadSavedCopilotApiKeyInfo();
  if (savedApiKey?.token && Number(savedApiKey?.expires_at || 0) > Math.floor(Date.now() / 1000) + 30) {
    applyRuntimeTokenInfo(savedApiKey);
    runtimeCopilotTokenSource = "saved_copilot_api_key";
    return {
      token: runtimeCopilotToken,
      source: runtimeCopilotTokenSource,
      apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
    };
  }

  if (runtimeIsFresh && runtimeCopilotToken) {
    if (runtimeCopilotTokenSource === "env" && !runtimeCopilotApiBase) {
      let exchanged = false;
      try {
        await exchangeGithubAccessForCopilotApiKey(runtimeCopilotToken);
        exchanged = true;
        return {
          token: runtimeCopilotToken,
          source: runtimeCopilotTokenSource,
          apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
        };
      } catch {
        // Keep env token fallback; some environments provide non-exchangeable tokens.
      }

      if (!exchanged) {
        try {
          const oauthAccessToken = await loadSavedCopilotOAuthAccessToken();
          if (oauthAccessToken) {
            await exchangeGithubAccessForCopilotApiKey(oauthAccessToken);
            return {
              token: runtimeCopilotToken,
              source: runtimeCopilotTokenSource,
              apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
            };
          }
        } catch {
          // Keep env token fallback.
        }
      }
    }

    return {
      token: runtimeCopilotToken,
      source: runtimeCopilotTokenSource,
      apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
    };
  }

  const oauthAccessToken = await loadSavedCopilotOAuthAccessToken();
  if (oauthAccessToken) {
    await exchangeGithubAccessForCopilotApiKey(oauthAccessToken);
    return {
      token: runtimeCopilotToken,
      source: runtimeCopilotTokenSource,
      apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
    };
  }

  if (runtimeCopilotToken) {
    return {
      token: runtimeCopilotToken,
      source: runtimeCopilotTokenSource,
      apiBase: runtimeCopilotApiBase || COPILOT_BASE_URL
    };
  }

  throw new Error("Copilot token not available. Use /admin/auth/start then /admin/auth/poll.");
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.name === "SyntaxError")) {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function capturePreviousEnv(env) {
  const previous = {};
  for (const key of CLAUDE_ENV_KEYS) {
    previous[key] = {
      exists: Object.prototype.hasOwnProperty.call(env, key),
      value: env[key]
    };
  }
  return previous;
}

function applyEnvSnapshot(env, snapshot) {
  for (const key of CLAUDE_ENV_KEYS) {
    const prev = snapshot?.[key];
    if (prev?.exists) {
      env[key] = prev.value;
      continue;
    }
    delete env[key];
  }
}

function applyProxyEnv(env, modelOverride) {
  const targetModel = modelOverride || DEFAULT_MODEL;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
  env.ANTHROPIC_API_KEY = CLAUDE_PROXY_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.ANTHROPIC_MODEL = targetModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = targetModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = targetModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = targetModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = targetModel;
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
}

async function getClaudeSettings() {
  return readJsonFileSafe(CLAUDE_SETTINGS_PATH, {});
}

async function setModeProxy(modelOverride) {
  const settings = await getClaudeSettings();
  const env = { ...(settings.env || {}) };
  const previousEnv = capturePreviousEnv(env);

  applyProxyEnv(env, modelOverride);

  settings.env = env;
  await writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
  await writeJsonFile(CLAUDE_PROXY_STATE_PATH, {
    mode: "proxy",
    selectedModel: modelOverride || DEFAULT_MODEL,
    previousEnv,
    updatedAt: new Date().toISOString()
  });
}

async function setModeNative() {
  const settings = await getClaudeSettings();
  const state = await readJsonFileSafe(CLAUDE_PROXY_STATE_PATH, null);
  const env = { ...(settings.env || {}) };

  if (state?.previousEnv) {
    applyEnvSnapshot(env, state.previousEnv);
  } else {
    for (const key of CLAUDE_ENV_KEYS) {
      delete env[key];
    }
  }

  if (Object.keys(env).length === 0) {
    delete settings.env;
  } else {
    settings.env = env;
  }

  await writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
  try {
    await fs.unlink(CLAUDE_PROXY_STATE_PATH);
  } catch (error) {
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function getSwitchStatus() {
  const settings = await getClaudeSettings();
  const state = await readJsonFileSafe(CLAUDE_PROXY_STATE_PATH, null);
  const env = settings?.env || {};

  return {
    mode: state?.mode === "proxy" ? "proxy" : "native",
    selected_model: env.ANTHROPIC_MODEL || null,
    settings_path: CLAUDE_SETTINGS_PATH,
    bridge_url: `http://127.0.0.1:${PORT}`,
    current_env: Object.fromEntries(CLAUDE_ENV_KEYS.filter((key) => key in env).map((key) => [key, env[key]]))
  };
}

function adminHtml() {
  // Resolve relative to this file so it works regardless of cwd (e.g. when run via npx)
  const adminPath = path.join(__dirname, "admin.html");
  try {
    return fsSync.readFileSync(adminPath, "utf8");
  } catch (err) {
    return `<h1>Error: admin.html not found</h1><p>${err.message}</p>`;
  }
}

function textFromUpstreamMessage(message) {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part) {
          return "";
        }
        if (typeof part === "string") {
          return part;
        }
        if (part.type === "text") {
          return String(part.text || "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((call) => {
    let parsed = {};
    try {
      parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      parsed = { raw: call?.function?.arguments || "" };
    }

    return {
      type: "tool_use",
      id: call.id || createId("toolu"),
      name: call?.function?.name || "tool",
      input: parsed
    };
  });
}

function anthropicUsageFromOpenAi(usage) {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0
    };
  }

  return {
    input_tokens: Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0)
  };
}

function anthropicStopReason(choice) {
  const reason = choice?.finish_reason;
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "stop") {
    return "end_turn";
  }
  return "end_turn";
}

function buildAnthropicResponse(upstream) {
  const choice = upstream?.choices?.[0] || {};
  const message = choice.message || {};
  const text = textFromUpstreamMessage(message);
  const toolBlocks = parseToolCalls(message.tool_calls);
  const content = [];

  if (text) {
    content.push({ type: "text", text });
  }
  content.push(...toolBlocks);

  return {
    id: createId("msg"),
    type: "message",
    role: "assistant",
    model: upstream?.model || "unknown",
    content,
    stop_reason: anthropicStopReason(choice),
    stop_sequence: null,
    usage: anthropicUsageFromOpenAi(upstream?.usage)
  };
}

function writeSse(res, event, dataObj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function emitMappedAnthropicSse(res, mapped) {
  const messageId = mapped?.id || createId("msg");
  const model = mapped?.model || DEFAULT_MODEL;
  const content = Array.isArray(mapped?.content) ? mapped.content : [];

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  });

  let index = 0;
  for (const block of content) {
    if (block?.type === "text") {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" }
      });
      if (typeof block.text === "string" && block.text.length > 0) {
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "text_delta",
            text: block.text
          }
        });
      }
      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index
      });
      index += 1;
      continue;
    }

    if (block?.type === "tool_use") {
      const toolName = String(block.name || "tool");
      const toolInput = normalizeToolInput(toolName, block.input);
      const toolInputJson = stringifyFunctionArguments(toolInput) || "{}";
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: String(block.id || createId("toolu")),
          name: toolName,
          input: {}
        }
      });
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: toolInputJson
        }
      });
      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index
      });
      index += 1;
    }
  }

  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: mapped?.stop_reason || "end_turn",
      stop_sequence: mapped?.stop_sequence || null
    },
    usage: {
      output_tokens: Number(mapped?.usage?.output_tokens || 0)
    }
  });

  writeSse(res, "message_stop", {
    type: "message_stop"
  });
}

async function proxyStreaming(payload, res, initiator) {
  const upstreamBody = cleanUndefined(buildOpenAiRequest({ ...payload, stream: true }));
  const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_CHAT_PATH}`, {
    method: "POST",
    headers: buildCopilotHeaders({ "x-initiator": initiator }),
    body: JSON.stringify(upstreamBody)
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errText = await upstreamResponse.text();
    setLastBridgeTrace({ note: "chat stream upstream error" });
    endLiveBridgeState({ note: "chat stream upstream error", error: errText || "upstream error" });
    return res.status(upstreamResponse.status).json({
      error: {
        type: "upstream_error",
        message: errText || "Upstream streaming request failed"
      }
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const messageId = createId("msg");
  const model = upstreamBody.model || DEFAULT_MODEL;
  let textBlockIndex = null;
  let nextContentIndex = 0;
  let textOutputTokens = 0;
  let sentMessageStop = false;
  let startedToolBlocks = 0;
  const toolBlocksByKey = new Map();
  const toolBlocksById = new Map();

  function getToolBlockKey(toolCallDelta) {
    if (Number.isInteger(toolCallDelta?.index)) {
      return `idx:${toolCallDelta.index}`;
    }
    if (typeof toolCallDelta?.id === "string" && toolCallDelta.id) {
      return `id:${toolCallDelta.id}`;
    }
    return undefined;
  }

  function ensureToolBlock(toolCallDelta) {
    const key = getToolBlockKey(toolCallDelta);
    const toolId = typeof toolCallDelta?.id === "string" && toolCallDelta.id ? toolCallDelta.id : undefined;

    if (!key && toolId && toolBlocksById.has(toolId)) {
      return toolBlocksById.get(toolId);
    }
    if (!key) {
      return undefined;
    }

    let block = toolBlocksByKey.get(key);
    if (!block) {
      block = {
        key,
        index: nextContentIndex++,
        id: typeof toolCallDelta?.id === "string" && toolCallDelta.id ? toolCallDelta.id : createId("toolu"),
        name:
          typeof toolCallDelta?.function?.name === "string" && toolCallDelta.function.name
            ? toolCallDelta.function.name
            : "tool",
        closed: false
      };
      toolBlocksByKey.set(key, block);
      if (toolId) {
        toolBlocksById.set(toolId, block);
      }
      startedToolBlocks += 1;
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {}
        }
      });
      return block;
    }

    if (toolId) {
      block.id = toolId;
      toolBlocksById.set(toolId, block);
    }
    if (typeof toolCallDelta?.function?.name === "string" && toolCallDelta.function.name) {
      block.name = toolCallDelta.function.name;
    }
    return block;
  }

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = chunk?.choices?.[0];
      const delta = choice?.delta || {};
      const contentDelta = typeof delta.content === "string" ? delta.content : "";
      const toolCallsDelta = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      markLiveBridgeEvent(
        choice?.finish_reason
          ? "chat.finish"
          : toolCallsDelta.length > 0
            ? "chat.tool.delta"
            : contentDelta
              ? "chat.text.delta"
              : "chat.chunk"
      );

      if (contentDelta) {
        if (textBlockIndex === null) {
          textBlockIndex = nextContentIndex++;
          writeSse(res, "content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: {
              type: "text",
              text: ""
            }
          });
        }

        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: {
            type: "text_delta",
            text: contentDelta
          }
        });
        textOutputTokens += Math.max(1, Math.ceil(contentDelta.length / 4));
      }

      for (const toolCallDelta of toolCallsDelta) {
        const block = ensureToolBlock(toolCallDelta);
        const argsDelta =
          typeof toolCallDelta?.function?.arguments === "string" ? toolCallDelta.function.arguments : "";
        if (!block || !argsDelta) {
          continue;
        }

        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: {
            type: "input_json_delta",
            partial_json: argsDelta
          }
        });
      }

      if (choice?.finish_reason && !sentMessageStop) {
        if (textBlockIndex !== null) {
          writeSse(res, "content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex
          });
        }

        for (const block of toolBlocksByKey.values()) {
          if (block.closed) {
            continue;
          }
          writeSse(res, "content_block_stop", {
            type: "content_block_stop",
            index: block.index
          });
          block.closed = true;
        }

        writeSse(res, "message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: anthropicStopReason(choice),
            stop_sequence: null
          },
          usage: {
            output_tokens: textOutputTokens
          }
        });

        writeSse(res, "message_stop", {
          type: "message_stop"
        });
        sentMessageStop = true;
        setLastBridgeTrace({
          response_tool_use_count: startedToolBlocks,
          response_text_chars: textOutputTokens * 4,
          note: "chat stream mapped"
        });
        endLiveBridgeState({ note: "chat stream completed" });
      }
    }
  }

  endLiveBridgeState({ note: "chat stream ended" });
  res.end();
}

async function proxyStreamingMessages(payload, res, initiator) {
  const model = payload.model || DEFAULT_MODEL;
  const upstreamBody = {
    ...payload,
    model,
    stream: true
  };

  const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_MESSAGES_PATH}`, {
    method: "POST",
    headers: buildCopilotHeaders({
      "x-initiator": initiator,
      "anthropic-version": COPILOT_ANTHROPIC_VERSION
    }),
    body: JSON.stringify(upstreamBody)
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errText = await upstreamResponse.text();
    setLastBridgeTrace({ note: "messages stream upstream error" });
    endLiveBridgeState({ note: "messages stream upstream error", error: errText || "upstream error" });
    return res.status(upstreamResponse.status).json({
      error: {
        type: "upstream_error",
        message: errText || "Upstream streaming request failed"
      }
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = upstreamResponse.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    markLiveBridgeEvent("messages.bytes");
    res.write(Buffer.from(value));
  }

  setLastBridgeTrace({ note: "messages stream passthrough" });
  endLiveBridgeState({ note: "messages stream ended" });

  res.end();
}

async function proxyStreamingResponses(payload, res, initiator) {
  const model = payload.model || DEFAULT_MODEL;

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    const requestBody = cleanUndefined(buildResponsesRequest({ ...payload, model, stream: false }));
    const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_RESPONSES_PATH}`, {
      method: "POST",
      headers: buildCopilotHeaders({ "x-initiator": initiator }),
      body: JSON.stringify(requestBody)
    });

    const { rawText, parsed } = await readUpstreamJsonResponse(upstreamResponse);

    if (!upstreamResponse.ok) {
      const errMessage = getUpstreamErrorMessage(parsed, rawText, "Upstream request failed");
      setLastBridgeTrace({ note: `responses buffered upstream error: ${errMessage}` });
      endLiveBridgeState({ note: "responses buffered upstream error", error: errMessage });
      return res.status(upstreamResponse.status).json({
        error: {
          type: "upstream_error",
          message: errMessage
        }
      });
    }

    const mapped = buildAnthropicResponseFromResponses(parsed, model);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    emitMappedAnthropicSse(res, mapped);
    setLastBridgeTrace({
      response_tool_use_count: Array.isArray(mapped.content)
        ? mapped.content.filter((c) => c?.type === "tool_use").length
        : 0,
      response_text_chars: Array.isArray(mapped.content)
        ? mapped.content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .reduce((n, c) => n + c.text.length, 0)
        : 0,
      note: `responses buffered->sse mapped (stop_reason=${mapped?.stop_reason || "end_turn"})`
    });
    endLiveBridgeState({ note: "responses buffered stream completed" });
    res.end();
    return;
  }

  const upstreamBody = cleanUndefined(buildResponsesRequest({ ...payload, model, stream: true }));
  let retries = 0;

  while (true) {
    const shouldKeepTools = retries === 0;
    const requestBody = shouldKeepTools
      ? upstreamBody
      : cleanUndefined({
          ...upstreamBody,
          tools: undefined,
          tool_choice: undefined,
          input: [{ role: "user", content: "Continue and answer without tool calls." }, ...(upstreamBody.input || [])]
        });

    const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_RESPONSES_PATH}`, {
      method: "POST",
      headers: buildCopilotHeaders({ "x-initiator": initiator }),
      body: JSON.stringify(requestBody)
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const { rawText, parsed } = await readUpstreamJsonResponse(upstreamResponse);
      const errMessage = getUpstreamErrorMessage(parsed, rawText, "Upstream streaming request failed");
      setLastBridgeTrace({ note: `responses stream upstream error: ${errMessage}` });
      endLiveBridgeState({ note: "responses stream upstream error", error: errMessage });
      return res.status(upstreamResponse.status).json({
        error: {
          type: "upstream_error",
          message: errMessage
        }
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const messageId = createId("msg");
    let sentTextBlockStart = false;
    let textIndex = null;
    let nextContentIndex = 0;
    let sentStop = false;
    let outputTokens = 0;
    let sawToolUse = false;
    let argDeltaEvents = 0;
    const toolBlocksByItemId = new Map();
    const toolBlocksByCallId = new Map();

  function resolveToolBlock(itemId, callId) {
    if (itemId && toolBlocksByItemId.has(itemId)) {
      return toolBlocksByItemId.get(itemId);
    }
    if (callId && toolBlocksByCallId.has(callId)) {
      return toolBlocksByCallId.get(callId);
    }
    const openBlocks = [...toolBlocksByItemId.values()].filter((b) => !b.closed);
    if (openBlocks.length === 1) {
      return openBlocks[0];
    }
    return undefined;
  }

    writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  });

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const type = String(chunk?.type || "");
      const deltaText = typeof chunk?.delta === "string" ? chunk.delta : "";
      markLiveBridgeEvent(type || "responses.chunk");

      if (type === "response.output_item.added") {
        const item = chunk?.item || {};
        if (isFunctionCallItem(item)) {
          sawToolUse = true;
          const itemId = String(item?.id || item?.call_id || createId("item"));
          const callId = String(item?.call_id || createId("call"));
          const toolName = String(functionCallNameFromItem(item) || "tool");
          const block = {
            index: nextContentIndex++,
            id: callId,
            name: toolName,
            arguments: "",
            normalizedInput: {},
            closed: false,
            emittedDelta: false
          };
          toolBlocksByItemId.set(itemId, block);
          toolBlocksByCallId.set(callId, block);
          writeSse(res, "content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {}
            }
          });

          const initialArgs = stringifyFunctionArguments(functionCallArgumentsFromItem(item));
          if (initialArgs) {
            const parsed = parseJsonLoose(initialArgs, { raw: initialArgs });
            const normalized = normalizeToolInput(toolName, parsed);
            const normalizedJson = stringifyFunctionArguments(normalized);
            block.arguments = normalizedJson || initialArgs;
            block.normalizedInput = normalized;
            block.emittedDelta = true;
            writeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: {
                type: "input_json_delta",
                partial_json: block.arguments
              }
            });
          }
        }
      }

      if (type === "response.function_call_arguments.delta") {
        argDeltaEvents += 1;
        const itemId = String(chunk?.item_id || "");
        const block = resolveToolBlock(itemId, null);
        const argsDelta = typeof chunk?.delta === "string" ? chunk.delta : "";
        if (block && argsDelta) {
          block.arguments += argsDelta;
          block.emittedDelta = true;
          writeSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: {
              type: "input_json_delta",
              partial_json: argsDelta
            }
          });
        }
      }

      if (type === "response.function_call_arguments.done") {
        const itemId = String(chunk?.item_id || "");
        const block = resolveToolBlock(itemId, null);
        const finalArgs = stringifyFunctionArguments(chunk?.arguments);
        if (block && finalArgs) {
          const parsed = parseJsonLoose(finalArgs, { raw: finalArgs });
          const normalized = normalizeToolInput(block.name, parsed);
          const normalizedJson = stringifyFunctionArguments(normalized);
          if (!block.emittedDelta) {
            writeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: {
                type: "input_json_delta",
                partial_json: normalizedJson || finalArgs
              }
            });
            block.emittedDelta = true;
          }
          block.arguments = normalizedJson || finalArgs;
          block.normalizedInput = normalized;
        }
      }

      if (type === "response.output_item.done") {
        const item = chunk?.item || {};
        if (isFunctionCallItem(item)) {
          sawToolUse = true;
        }
        const itemId = String(item?.id || "");
        const callId = String(item?.call_id || "");
        const block = resolveToolBlock(itemId, callId);
        if (block && !block.closed) {
          const rawFinalArgs = stringifyFunctionArguments(functionCallArgumentsFromItem(item)) || block.arguments || "";
          const parsed = parseJsonLoose(rawFinalArgs, { raw: rawFinalArgs });
          const normalized = normalizeToolInput(block.name, parsed);
          const normalizedJson = stringifyFunctionArguments(normalized) || rawFinalArgs;
          if (!block.emittedDelta && normalizedJson) {
            writeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: {
                type: "input_json_delta",
                partial_json: normalizedJson
              }
            });
            block.emittedDelta = true;
          }
          block.arguments = normalizedJson;
          block.normalizedInput = normalized;
          writeSse(res, "content_block_stop", {
            type: "content_block_stop",
            index: block.index
          });
          block.closed = true;
        }
      }

      if (type === "response.refusal.delta" && deltaText) {
        if (!sentTextBlockStart) {
          writeSse(res, "content_block_start", {
            type: "content_block_start",
            index: nextContentIndex,
            content_block: {
              type: "text",
              text: ""
            }
          });
          textIndex = nextContentIndex;
          nextContentIndex += 1;
          sentTextBlockStart = true;
        }

        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: {
            type: "text_delta",
            text: deltaText
          }
        });
        outputTokens += Math.max(1, Math.ceil(deltaText.length / 4));
      }

      if (type === "response.output_text.delta" && deltaText) {
        if (!sentTextBlockStart) {
          writeSse(res, "content_block_start", {
            type: "content_block_start",
            index: nextContentIndex,
            content_block: {
              type: "text",
              text: ""
            }
          });
          textIndex = nextContentIndex;
          nextContentIndex += 1;
          sentTextBlockStart = true;
        }

        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: {
            type: "text_delta",
            text: deltaText
          }
        });
        outputTokens += Math.max(1, Math.ceil(deltaText.length / 4));
      }

      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed" ||
        type === "response.cancelled"
      ) {
        const usage = chunk?.response?.usage || {};
        const finalOutputTokens = Number(usage.output_tokens || usage.completion_tokens || outputTokens || 0);

        if (sentTextBlockStart) {
          writeSse(res, "content_block_stop", {
            type: "content_block_stop",
            index: textIndex === null ? 0 : textIndex
          });
        }

        for (const block of toolBlocksByItemId.values()) {
          if (!block.closed) {
            writeSse(res, "content_block_stop", {
              type: "content_block_stop",
              index: block.index
            });
            block.closed = true;
          }
        }

        const stopReason = sawToolUse ? "tool_use" : "end_turn";

        writeSse(res, "message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null
          },
          usage: {
            output_tokens: finalOutputTokens
          }
        });

        writeSse(res, "message_stop", {
          type: "message_stop"
        });
        setLastBridgeTrace({
          response_tool_use_count: sawToolUse ? 1 : 0,
          response_text_chars: outputTokens * 4,
          note: `responses stream mapped (stop_reason=${stopReason})`
        });
        endLiveBridgeState({ note: `responses stream completed (stop_reason=${stopReason})` });
        sentStop = true;
      }
    }
    }

    if (!sentStop) {
    if (sentTextBlockStart) {
      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index: textIndex === null ? 0 : textIndex
      });
    }

    for (const block of toolBlocksByItemId.values()) {
      if (!block.closed) {
        writeSse(res, "content_block_stop", {
          type: "content_block_stop",
          index: block.index
        });
        block.closed = true;
      }
    }

    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: sawToolUse ? "tool_use" : "end_turn",
        stop_sequence: null
      },
      usage: {
        output_tokens: outputTokens
      }
    });

    writeSse(res, "message_stop", {
      type: "message_stop"
    });
    setLastBridgeTrace({
      response_tool_use_count: sawToolUse ? 1 : 0,
      response_text_chars: outputTokens * 4,
      note: "responses stream mapped (fallback close)"
    });
    endLiveBridgeState({ note: "responses stream fallback close" });
    }

    const stallDetected = sawToolUse && argDeltaEvents > ARG_STREAM_STALL_EVENT_THRESHOLD && !sentStop;
    if (stallDetected && retries < ARG_STREAM_STALL_RETRY_LIMIT) {
      retries += 1;
      setLastBridgeTrace({
        note: `responses stream retry without tools (arg_delta_events=${argDeltaEvents})`
      });
      continue;
    }

    endLiveBridgeState({ note: "responses stream ended" });
    res.end();
    return;
  }
}

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    upstream_chat: `${getCopilotApiBase()}${COPILOT_CHAT_PATH}`,
    upstream_messages: `${getCopilotApiBase()}${COPILOT_MESSAGES_PATH}`,
    upstream_responses: `${getCopilotApiBase()}${COPILOT_RESPONSES_PATH}`,
    upstream_models: `${getCopilotApiBase()}${COPILOT_MODELS_PATH}`
  });
});

app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(adminHtml());
});

app.get("/admin/status", async (req, res) => {
  try {
    const status = await getSwitchStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.get("/admin/trace", (req, res) => {
  res.json(lastBridgeTrace);
});

app.get("/admin/live", (req, res) => {
  res.json(liveBridgeState);
});

app.get("/admin/auth/status", async (req, res) => {
  try {
    let ensureError = null;
    try {
      await ensureCopilotAuthReady();
    } catch (error) {
      ensureError = error instanceof Error ? error.message : "Failed to refresh auth state";
    }

    const savedApiKey = await loadSavedCopilotApiKeyInfo();
    const savedOauth = await loadSavedCopilotOAuthAccessToken();
    const now = Math.floor(Date.now() / 1000);
    return res.json({
      runtime: {
        has_token: Boolean(runtimeCopilotToken),
        token_source: runtimeCopilotTokenSource,
        expires_at: runtimeCopilotTokenExpiresAt,
        expires_in_sec:
          typeof runtimeCopilotTokenExpiresAt === "number" ? runtimeCopilotTokenExpiresAt - now : null,
        api_base: runtimeCopilotApiBase || COPILOT_BASE_URL
      },
      saved: {
        has_oauth_access_token: Boolean(savedOauth),
        has_copilot_api_key: Boolean(savedApiKey?.token),
        copilot_api_key_expires_at: savedApiKey?.expires_at || null,
        copilot_api_key_expires_in_sec:
          typeof savedApiKey?.expires_at === "number" ? savedApiKey.expires_at - now : null
      },
      ensure_error: ensureError
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/admin/auth/start", async (req, res) => {
  try {
    const response = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "GithubCopilot/1.155.0"
      },
      body: JSON.stringify({
        client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
        scope: "read:user"
      })
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: {
          type: "upstream_error",
          message: parsed?.error_description || parsed?.error || text || "Failed to start device auth"
        }
      });
    }

    pendingDeviceCode = {
      device_code: parsed?.device_code,
      user_code: parsed?.user_code,
      verification_uri: parsed?.verification_uri,
      interval: parsed?.interval || 5,
      expires_in: parsed?.expires_in || 900,
      created_at: Date.now()
    };

    return res.json({
      ok: true,
      user_code: pendingDeviceCode.user_code,
      verification_uri: pendingDeviceCode.verification_uri,
      interval: pendingDeviceCode.interval,
      expires_in: pendingDeviceCode.expires_in
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/admin/auth/poll", async (req, res) => {
  try {
    if (!pendingDeviceCode?.device_code) {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "No pending device flow. Start with /admin/auth/start"
        }
      });
    }

    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "GithubCopilot/1.155.0"
      },
      body: JSON.stringify({
        client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
        device_code: pendingDeviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (parsed?.error === "authorization_pending") {
      const now = Date.now();
      const createdAt = pendingDeviceCode.created_at || now;
      const expiresInSec = pendingDeviceCode.expires_in || 900;
      const remainingSec = Math.max(0, Math.floor((createdAt + (expiresInSec * 1000) - now) / 1000));

      return res.json({
        ok: false,
        status: "pending",
        retry_after_sec: pendingDeviceCode.interval || 5,
        expires_in_sec: remainingSec
      });
    }

    if (!response.ok || !parsed?.access_token) {
      return res.status(response.status || 400).json({
        error: {
          type: "upstream_error",
          message: parsed?.error_description || parsed?.error || text || "Failed to obtain access token"
        }
      });
    }

    await saveCopilotOAuthAccessToken(parsed.access_token);
    await exchangeGithubAccessForCopilotApiKey(parsed.access_token);
    pendingDeviceCode = null;

    return res.json({
      ok: true,
      status: "authenticated",
      api_base: runtimeCopilotApiBase || COPILOT_BASE_URL,
      token_expires_at: runtimeCopilotTokenExpiresAt
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/admin/auth/refresh", async (req, res) => {
  try {
    const source = String(req.body?.source || "").trim();

    if (source && source !== "env" && source !== "oauth" && source !== "saved") {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "source must be one of: env, oauth, saved"
        }
      });
    }

    const savedApiKey = await loadSavedCopilotApiKeyInfo();
    const savedOauth = await loadSavedCopilotOAuthAccessToken();

    if (!source || source === "saved") {
      if (savedApiKey?.token && Number(savedApiKey?.expires_at || 0) > Math.floor(Date.now() / 1000) + 30) {
        applyRuntimeTokenInfo(savedApiKey);
        runtimeCopilotTokenSource = "saved_copilot_api_key";
        return res.json({
          ok: true,
          source: runtimeCopilotTokenSource,
          api_base: runtimeCopilotApiBase || COPILOT_BASE_URL
        });
      }
      if (source === "saved") {
        return res.status(400).json({
          error: {
            type: "invalid_request_error",
            message: "No fresh saved Copilot API key available"
          }
        });
      }
    }

    if (!source || source === "oauth") {
      if (savedOauth) {
        const info = await exchangeGithubAccessForCopilotApiKey(savedOauth);
        return res.json({
          ok: true,
          source: runtimeCopilotTokenSource,
          api_base: runtimeCopilotApiBase || COPILOT_BASE_URL,
          expires_at: info?.expires_at || null
        });
      }
      if (source === "oauth") {
        return res.status(400).json({
          error: {
            type: "invalid_request_error",
            message: "No saved OAuth token available. Use /admin/auth/start then /admin/auth/poll"
          }
        });
      }
    }

    if (!source || source === "env") {
      if (!runtimeCopilotToken) {
        return res.status(400).json({
          error: {
            type: "invalid_request_error",
            message: "No runtime token available from env"
          }
        });
      }
      const info = await exchangeGithubAccessForCopilotApiKey(runtimeCopilotToken);
      return res.json({
        ok: true,
        source: runtimeCopilotTokenSource,
        api_base: runtimeCopilotApiBase || COPILOT_BASE_URL,
        expires_at: info?.expires_at || null
      });
    }

    return res.status(400).json({
      error: {
        type: "invalid_request_error",
        message: "Unable to refresh auth with requested source"
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/admin/probe-model", async (req, res) => {
  try {
    await ensureCopilotAuthReady();
    const model = String(req.body?.model || "").trim();
    if (!model) {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "model is required"
        }
      });
    }

    const attempts = [
      {
        mode: "responses[user]",
        url: `${getCopilotApiBase()}${COPILOT_RESPONSES_PATH}`,
        headers: buildCopilotHeaders({ "x-initiator": "user" }),
        body: {
          model,
          stream: false,
          input: [{ role: "user", content: "Say ok" }],
          max_output_tokens: 32
        }
      },
      {
        mode: "chat[user]",
        url: `${getCopilotApiBase()}${COPILOT_CHAT_PATH}`,
        headers: buildCopilotHeaders({ "x-initiator": "user" }),
        body: {
          model,
          messages: [{ role: "user", content: "Say ok" }],
          max_tokens: 32
        }
      },
      {
        mode: "chat[agent]",
        url: `${getCopilotApiBase()}${COPILOT_CHAT_PATH}`,
        headers: buildCopilotHeaders({ "x-initiator": "agent" }),
        body: {
          model,
          messages: [{ role: "user", content: "Say ok" }],
          max_tokens: 32
        }
      }
    ];

    const results = [];
    for (const attempt of attempts) {
      const upstream = await fetch(attempt.url, {
        method: "POST",
        headers: attempt.headers,
        body: JSON.stringify(attempt.body)
      });

      const txt = await upstream.text();
      let parsed = null;
      try {
        parsed = txt ? JSON.parse(txt) : null;
      } catch {}

      results.push({
        mode: attempt.mode,
        status: upstream.status,
        ok: upstream.ok,
        message: parsed?.error?.message || txt || ""
      });
    }

    return res.json({
      model,
      headers_hint: {
        editor_version: COPILOT_EDITOR_VERSION,
        editor_plugin_version: COPILOT_EDITOR_PLUGIN_VERSION,
        integration_id: COPILOT_INTEGRATION_ID
      },
      results
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.get("/admin/models", async (req, res) => {
  try {
    const rows = await getCopilotModels();
    const allowedIds = new Set(ADMIN_MODEL_ALLOWLIST);
    const discovered = rows
      .filter((row) => row && typeof row === "object")
      .filter((row) => row.id)
      .filter((row) => allowedIds.has(String(row.id)))
      .filter((row) => {
        const type = row?.capabilities?.type;
        const endpoints = Array.isArray(row.supported_endpoints) ? row.supported_endpoints : [];
        return type === "chat" || endpoints.length > 0;
      })
      .filter((row) => row?.policy?.state !== "disabled")
      .map((row) => ({
        id: String(row.id),
        name: String(row.friendly_name || row.name || row.id),
        vendor: String(row.vendor || ""),
        model_picker_enabled: Boolean(row.model_picker_enabled),
        discovered: true,
        supported_endpoints: Array.isArray(row.supported_endpoints) ? row.supported_endpoints : []
      }));

    const byId = new Map(discovered.map((m) => [m.id, m]));
    const models = ADMIN_MODEL_ALLOWLIST.map((id) => {
      const found = byId.get(id);
      if (found) {
        return found;
      }
      return {
        id,
        name: id,
        vendor: "",
        model_picker_enabled: true,
        discovered: false,
        supported_endpoints: []
      };
    }).sort((a, b) => a.id.localeCompare(b.id));

    const status = await getSwitchStatus();
    return res.json({
      default_model: DEFAULT_MODEL,
      selected_model: status.selected_model,
      recommended_model: ADMIN_RECOMMENDED_MODEL,
      models
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/admin/mode", async (req, res) => {
  try {
    const mode = req.body?.mode;
    const model = req.body?.model;
    if (mode !== "proxy" && mode !== "native") {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "mode must be 'proxy' or 'native'"
        }
      });
    }

    if (mode === "proxy") {
      await setModeProxy(typeof model === "string" && model ? model : undefined);
    } else {
      await setModeNative();
    }

    return res.json(await getSwitchStatus());
  } catch (error) {
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

app.post("/v1/messages", async (req, res) => {
  try {
    await ensureCopilotAuthReady();
    const payload = req.body || {};
    const requestId = createId("req");
    const model = payload.model || DEFAULT_MODEL;
    const mode = await resolveUpstreamMode(model);
    const initiator = resolveCopilotInitiator(model, payload);
    startLiveBridgeState({ requestId, model, mode, stream: Boolean(payload.stream) });
    setLastBridgeTrace({
      model,
      mode,
      stream: Boolean(payload.stream),
      request_tools_count: Array.isArray(payload.tools) ? payload.tools.length : 0,
      request_tool_choice: payload.tool_choice || null,
      response_tool_use_count: 0,
      response_text_chars: 0,
      note: "request accepted",
      request_tools_shape: extractToolSchemaShape(payload.tools),
      request_tools_preview: Array.isArray(payload.tools)
        ? payload.tools.slice(0, 3).map((t) => ({
            name: t?.name,
            description_type: typeof t?.description,
            input_schema_type: typeof t?.input_schema
          }))
        : []
    });

    if (!Array.isArray(payload.messages)) {
      endLiveBridgeState({ note: "invalid request", error: "messages must be an array" });
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "messages must be an array"
        }
      });
    }

    if (payload.stream) {
      res.setHeader("x-bridge-mode", mode);
      if (mode === "responses") {
        return await proxyStreamingResponses({ ...payload, model }, res, initiator);
      }
      if (mode === "messages") {
        return await proxyStreamingMessages({ ...payload, model }, res, initiator);
      }
      return await proxyStreaming({ ...payload, model }, res, initiator);
    }

    if (mode === "responses") {
      const upstreamBody = cleanUndefined(buildResponsesRequest({ ...payload, model, stream: false }));
      const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_RESPONSES_PATH}`, {
        method: "POST",
        headers: buildCopilotHeaders({ "x-initiator": initiator }),
        body: JSON.stringify(upstreamBody)
      });

      const { rawText, parsed } = await readUpstreamJsonResponse(upstreamResponse);

      if (!upstreamResponse.ok) {
        setLastBridgeTrace({ note: "responses upstream error" });
        endLiveBridgeState({ note: "responses upstream error", error: getUpstreamErrorMessage(parsed, rawText) });
        return res.status(upstreamResponse.status).json({
          error: {
            type: "upstream_error",
            message: getUpstreamErrorMessage(parsed, rawText)
          }
        });
      }
      const mapped = buildAnthropicResponseFromResponses(parsed, model);
      const stopReason = mapped?.stop_reason || "end_turn";
      setLastBridgeTrace({
        response_tool_use_count: Array.isArray(mapped.content)
          ? mapped.content.filter((c) => c?.type === "tool_use").length
          : 0,
        response_text_chars: Array.isArray(mapped.content)
          ? mapped.content
              .filter((c) => c?.type === "text" && typeof c.text === "string")
              .reduce((n, c) => n + c.text.length, 0)
          : 0,
        note: `responses mapped (stop_reason=${stopReason})`
      });
      endLiveBridgeState({ note: `responses non-stream completed (stop_reason=${stopReason})` });
      res.setHeader("x-bridge-mode", mode);
      return res.json(mapped);
    }

    if (mode === "messages") {
      const upstreamBody = {
        ...payload,
        model,
        stream: false
      };

      const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_MESSAGES_PATH}`, {
        method: "POST",
        headers: buildCopilotHeaders({
          "x-initiator": initiator,
          "anthropic-version": COPILOT_ANTHROPIC_VERSION
        }),
        body: JSON.stringify(upstreamBody)
      });

      const { rawText, parsed } = await readUpstreamJsonResponse(upstreamResponse);

      if (!upstreamResponse.ok) {
        setLastBridgeTrace({ note: "messages upstream error" });
        endLiveBridgeState({ note: "messages upstream error", error: getUpstreamErrorMessage(parsed, rawText) });
        return res.status(upstreamResponse.status).json({
          error: {
            type: "upstream_error",
            message: getUpstreamErrorMessage(parsed, rawText)
          }
        });
      }
      setLastBridgeTrace({ note: "messages passthrough" });
      endLiveBridgeState({ note: "messages non-stream completed" });
      res.setHeader("x-bridge-mode", mode);
      return res.json(parsed);
    }

    const upstreamBody = cleanUndefined(buildOpenAiRequest({ ...payload, model, stream: false }));
    const upstreamResponse = await fetch(`${getCopilotApiBase()}${COPILOT_CHAT_PATH}`, {
      method: "POST",
      headers: buildCopilotHeaders({ "x-initiator": initiator }),
      body: JSON.stringify(upstreamBody)
    });

    const { rawText, parsed } = await readUpstreamJsonResponse(upstreamResponse);

    if (!upstreamResponse.ok) {
      setLastBridgeTrace({ note: "chat upstream error" });
      endLiveBridgeState({ note: "chat upstream error", error: getUpstreamErrorMessage(parsed, rawText) });
      return res.status(upstreamResponse.status).json({
        error: {
          type: "upstream_error",
          message: getUpstreamErrorMessage(parsed, rawText)
        }
      });
    }
    const mapped = buildAnthropicResponse(parsed);
    setLastBridgeTrace({
      response_tool_use_count: Array.isArray(mapped.content)
        ? mapped.content.filter((c) => c?.type === "tool_use").length
        : 0,
      response_text_chars: Array.isArray(mapped.content)
        ? mapped.content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .reduce((n, c) => n + c.text.length, 0)
        : 0,
      note: "chat mapped"
    });
    endLiveBridgeState({ note: "chat non-stream completed" });
    res.setHeader("x-bridge-mode", mode);
    return res.json(mapped);
  } catch (error) {
    setLastBridgeTrace({ note: "internal error" });
    endLiveBridgeState({
      note: "internal error",
      error: error instanceof Error ? error.message : "Unexpected error"
    });
    return res.status(500).json({
      error: {
        type: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
  }
});

const server = app.listen(PORT, "127.0.0.1", () => {
  const ansi = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    gray: "\x1b[90m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    bold: "\x1b[1m"
  };

  const terminalWidth = process.stdout.columns || 100;
  const innerWidth = Math.max(49, Math.min(55, terminalWidth - 7));
  const leftInset = 4;

  const fitPlain = (text) => {
    if (text.length <= innerWidth) {
      return text;
    }
    return `${text.slice(0, innerWidth - 3)}...`;
  };

  const line = (plain = "", color = "") => {
    const withInset = plain ? `${" ".repeat(leftInset)}${plain}` : "";
    const fitted = fitPlain(withInset);
    const padding = " ".repeat(innerWidth - fitted.length);
    const styled = color ? `${color}${fitted}${ansi.reset}` : fitted;
    return `${ansi.gray}|${ansi.reset} ${styled}${padding} ${ansi.gray}|${ansi.reset}`;
  };

  const lineKV = (label, value, labelColor, valueColor) => {
    const separator = " : ";
    const maxValueLen = Math.max(0, innerWidth - leftInset - label.length - separator.length);
    const fittedValue =
      value.length <= maxValueLen ? value : `${value.slice(0, Math.max(0, maxValueLen - 3))}...`;
    const visibleLen = leftInset + label.length + separator.length + fittedValue.length;
    const padding = " ".repeat(Math.max(0, innerWidth - visibleLen));

    return `${ansi.gray}|${ansi.reset} ${" ".repeat(leftInset)}${labelColor}${label}${ansi.reset}${separator}${valueColor}${fittedValue}${ansi.reset}${padding} ${ansi.gray}|${ansi.reset}`;
  };

  const border = `${ansi.gray}+${"-".repeat(innerWidth + 2)}+${ansi.reset}`;

  (async () => {
    if (!COPILOT_ACCESS_TOKEN) {
      const savedKey = await loadSavedCopilotApiKeyInfo();
      const savedOAuth = await loadSavedCopilotOAuthAccessToken();
      if (!savedKey?.token && !savedOAuth) {
        console.log(`${ansi.yellow}[info]${ansi.reset} No token set yet — open the Admin UI to connect your GitHub account.`);
      }
    }
  })();

  console.log("");
  console.log(border);
  console.log(line());
  console.log(line("Copilot Claude Proxy is running", `${ansi.bold}${ansi.green}`));
  console.log(line());
  console.log(lineKV("Dashboard", `http://localhost:${PORT}/admin`, `${ansi.yellow}${ansi.bold}`, `${ansi.cyan}`));
  console.log(lineKV("Upstream ", `${getCopilotApiBase()}`, `${ansi.yellow}${ansi.bold}`, `${ansi.cyan}`));
  console.log(lineKV("Port     ", `${PORT}`, `${ansi.yellow}${ansi.bold}`, `${ansi.cyan}`));
  console.log(line());
  console.log(line("Press Ctrl+C to cleanly exit and revert config", `${ansi.dim}`));
  console.log(line());
  console.log(border);
  console.log("");
});

async function gracefulShutdown() {
  console.log("\n[proxy] Received shutdown signal...");
  try {
    const status = await getSwitchStatus();
    if (status.mode === "proxy") {
      console.log("[proxy] Reverting Claude settings to native before exit...");
      await setModeNative();
      console.log("[proxy] ✅ Successfully reverted Claude settings to native.");
    }
  } catch (err) {
    console.error("[proxy] ❌ Failed to revert Claude settings on exit:", err.message);
  }
  console.log("[proxy] Shutting down.");
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
