import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real MCP transport: every application interaction stays in agent-workspace-linux.
export class Workspace {
  constructor(id) {
    this.id = id;
    this.pending = new Map();
    this.nextId = 1;
    this.server = spawn("agent-workspace-linux", ["mcp", "--headless"], { stdio: ["pipe", "pipe", "pipe"] });
    this.errors = "";
    this.server.stderr.on("data", chunk => { this.errors += chunk; });
    createInterface({ input: this.server.stdout }).on("line", line => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.server.on("exit", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Workspace MCP exited")); }
      this.pending.clear();
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async tool(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: { id: this.id, ...args } });
    const text = response.content?.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (response.isError) throw new Error(text);
    const result = response.structuredContent ?? JSON.parse(text);
    if (result.ok === false) throw new Error(JSON.stringify(result));
    return result;
  }
  async start() {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-thread-e2e", version: "1" } });
    this.server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = await this.tool("workspace_start", { acknowledge_hidden_workspace: true, open_viewer: false, width: 1920, height: 1080, purpose: "Pi thread headless end-to-end tests" });
    if (!result.agent_mode?.headless) throw new Error("MCP must run headless");
    this.started = true;
    return result;
  }
  async terminal(command, terminal_id = "pi-thread") {
    this.terminalId = terminal_id;
    const result = await this.tool("workspace_run_in_terminal", { terminal_id, title: "Pi side-thread E2E", command, wait_window: true });
    this.windowId = result.windows[0]?.id;
    return result;
  }
  async resize(width, height = 1000) {
    await this.tool("workspace_resize_window", { window_id: this.windowId, width, height });
    await sleep(200);
  }
  async input(text, keys = []) {
    await this.tool("workspace_terminal_input", { terminal_id: this.terminalId, text, keys });
  }
  async key(...keys) { await this.input(undefined, keys); }
  async submit(text) { await this.input(text, ["Enter"]); }
  async read() { return (await this.tool("workspace_terminal_read", { terminal_id: this.terminalId })).screen.text; }
  async wait(text, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    let screen;
    while (Date.now() < deadline) {
      screen = await this.read();
      if (typeof text === "string" ? screen.includes(text) : text.test(screen)) { await sleep(100); return screen; }
      await sleep(100);
    }
    throw new Error(`Terminal did not show ${text}:\n${screen}`);
  }
  async stop() {
    try { if (this.started) await this.tool("workspace_stop"); }
    finally { this.server.stdin.end(); this.server.kill(); }
  }
}
