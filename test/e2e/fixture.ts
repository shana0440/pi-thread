import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI) {
  pi.registerMcpServer("thread_fixture", {
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))],
    exposure: "deferred",
  });
  pi.registerTool({
    name: "fixture_echo", label: "Fixture echo", description: "Echo a string for E2E testing.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args) { return { content: [{ type: "text", text: `fixture-echo: ${args.text}` }], details: {} }; },
  });
  pi.registerCommand("fixture-model", {
    handler: async (_args, ctx) => {
      const model = ctx.modelRegistry.find("thread-e2e", "thread-alternate");
      if (!model) throw new Error("Alternate fixture model missing");
      await pi.setModel(model);
      ctx.ui.notify("Main switched model", "info");
    },
  });
  pi.registerCommand("fixture-branch", {
    handler: async (_args, ctx) => {
      const target = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
      if (!target) throw new Error("No branch target");
      await ctx.navigateTree(target.id, { summarize: false });
      ctx.ui.notify("Branch navigation complete", "info");
    },
  });
  pi.registerCommand("fixture-dynamic", {
    handler: async (_args, ctx) => {
      pi.registerTool({
        name: "fixture_runtime_only", label: "Runtime-only fixture", description: "A tool that cannot be reconstructed from its factory.",
        parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "dynamic" }], details: {} }; },
      });
      ctx.ui.notify("Runtime-only tool registered", "info");
    },
  });
  pi.on("tool_call", event => {
    if (event.toolName === "write" && (event.input as { path?: string }).path === "protected.txt") {
      return { block: true, reason: "fixture-policy-denied" };
    }
  });
  pi.on("session_before_compact", event => ({
    compaction: {
      summary: "Project is pi-thread. Shared marker is SHARED_CEDAR_731. Main selected a side conversation fork.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
  pi.on("session_shutdown", (_event, ctx) => {
    if (process.env.THREAD_E2E_LIFECYCLE) appendFileSync(process.env.THREAD_E2E_LIFECYCLE, `${ctx.sessionManager.getSessionId()} shutdown\n`);
  });
}
