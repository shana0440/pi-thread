import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

if (process.env.THREAD_E2E_LIFECYCLE) appendFileSync(process.env.THREAD_E2E_LIFECYCLE, `mcp-start ${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "thread-fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo from the E2E MCP server.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: `mcp-echo: ${request.params.arguments.text}` }] };
  else if (request.method === "ping") result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
