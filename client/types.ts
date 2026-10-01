// Shared types for the slask-mcp client.
//
// Re-exports the MCP types we work with most, and defines the client-internal
// types (server specs, the multi-server registry, the agent-loop config) so the
// source files can reference them without a shared dependency cycle.

import type { CallToolResult, Client, Tool } from "@modelcontextprotocol/client";
import type { OpenAI } from "openai";

export { CallToolResult, Tool, Client } from "@modelcontextprotocol/client";

// ---------------------------------------------------------------------------
// Server specs
// ---------------------------------------------------------------------------

/** A streamable-HTTP server (the default "slask" server and any http entry). */
export interface HttpSpec {
  name: string;
  kind: "http";
  url: string;
  token: string | null;
}

/** A stdio (spawned-process) server. */
export interface StdioSpec {
  name: string;
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * How to route the child process' stderr. Only the Node `spawn` stream
   * values are valid; the default (when absent) is `"inherit"`.
   */
  stderr?: "inherit" | "pipe" | "ignore" | "overlapped";
  maxBufferSize?: number;
}

export type ServerSpec = HttpSpec | StdioSpec;

// ---------------------------------------------------------------------------
// Connection results
// ---------------------------------------------------------------------------

export interface Warning {
  name: string;
  error: string;
}

/** A tool with its user-facing call name (`key`) and raw MCP definition. */
export interface KeyedTool {
  key: string;
  tool: Tool;
}

export interface ServerView {
  name: string;
  kind: "http" | "stdio";
  client: Client;
  address: string;
  tools: Tool[];
  keyedTools: KeyedTool[];
}

export interface Registry {
  views: ServerView[];
  warnings: Warning[];
  keyedViews: ServerView[];
  byKey: Map<string, { view: ServerView; tool: Tool }>;
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

/**
 * A "flat" MCP tool: a name (the user-facing key), a description, and an input
 * schema. Returned by `servers.openAiTools()` and the raw `listTools()` result.
 */
export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** The OpenAI function-calling shape passed to `chat.completions.create`. */
export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Conversation messages (agent loop)
// ---------------------------------------------------------------------------

/**
 * A function tool call as emitted by an OpenAI-compatible completions API.
 * Mirrors the SDK's `ChatCompletionMessageFunctionToolCall` exactly. `arguments`
 * is a required `string` (the model always sends a JSON string, possibly empty)
 * — matching the SDK's shape so the array can be read back into history without
 * a cast.
 */
export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * A single message in the agent's conversation history. Structurally
 * compatible with the OpenAI SDK's `ChatCompletionMessageParam` union, so it
 * can be passed straight to `chat.completions.create` without a cast.
 */
export type ConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export interface AgentTurnConfig {
  openai: OpenAI;
  model: string;
  systemPrompt: string;
  tools: OpenAiFunctionTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultText: string;
}
