import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { sleep } from "./workspace.mjs";

export function lastUser(body) {
  const message = body.messages.filter(message => message.role === "user").at(-1);
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
}

export async function startModel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    const prompt = lastUser(body);
    if (prompt === "provider-error") { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "fixture-provider-error", type: "invalid_request_error" } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const id = `chatcmpl-${randomUUID()}`;
    const chunk = (delta, finish_reason = null) => {
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "thread-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    chunk({ role: "assistant" });
    const last = body.messages.at(-1);
    const call = (name, args) => {
      chunk({ tool_calls: [{ index: 0, id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls");
    };
    const previousCall = body.messages.at(-2)?.tool_calls?.at(-1)?.function?.name;
    if (last.role === "tool" && previousCall === "tool_search" && prompt === "mcp-echo") {
      call("mcp__thread_fixture__echo", { text: "SIDE_MCP_MARKER" });
    } else if (last.role === "tool") {
      chunk({ content: `Tool result: ${typeof last.content === "string" ? last.content : JSON.stringify(last.content)}` }); chunk({}, "stop");
    } else if (prompt === "write-shared") call("write", { path: "shared.txt", content: "shared-file-from-side" });
    else if (prompt === "read-shared") call("read", { path: "shared.txt" });
    else if (prompt === "fixture-echo") call("fixture_echo", { text: "SIDE_TOOL_MARKER" });
    else if (prompt === "mcp-echo") {
      if (body.tools?.some(tool => tool.function?.name === "mcp__thread_fixture__echo")) call("mcp__thread_fixture__echo", { text: "SIDE_MCP_MARKER" });
      else call("tool_search", { query: "thread_fixture echo", limit: 3 });
    }
    else if (prompt === "denied-write") call("write", { path: "protected.txt", content: "must-not-write" });
    else if (prompt === "long-tool") call("bash", { command: "sleep 20; printf late > late.txt", timeout: 30 });
    else if (/^slow-(main|side)(-\d+)?$/.test(prompt)) {
      for (let index = 0; index < 30 && !response.destroyed; index++) { chunk({ content: `${index === 0 ? prompt + ": " : ""}stream${index} ` }); await sleep(150); }
      chunk({ content: `${prompt}-FINISHED` }); chunk({}, "stop");
    } else {
      const content = prompt === "Explain the fork" ? "The side thread shares the conversation up to the fork point. New messages stay here; files remain shared."
        : prompt === "What project are we discussing?" ? "We are discussing pi-thread, the right-side conversation extension."
        : `ACK ${prompt}`;
      for (const word of content.split(/(?<=\s)/)) { chunk({ content: word }); await sleep(15); }
      chunk({}, "stop");
    }
    if (!response.destroyed) response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, requests, close: () => { server.closeAllConnections(); server.close(); } };
}
