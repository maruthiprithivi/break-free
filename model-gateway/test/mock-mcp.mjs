// Tiny stdio MCP server used to test the MCP bridge: one harmless tool, one "destructive" tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-mcp", version: "0" });
server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `ECHO:${text}` }] }));
server.registerTool("delete_thing", { description: "Destructive", inputSchema: { id: z.string() } }, async ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }));
server.registerTool("fail", { description: "Always errors", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "nope" }], isError: true }));
await server.connect(new StdioServerTransport());
