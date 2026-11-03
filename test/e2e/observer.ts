import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Observes actual completed runs for the real-provider recording; does not alter runs/context/UI.
export default function observer(pi: ExtensionAPI) {
  pi.on("agent_settled", (event, ctx) => {
    if (!process.env.THREAD_DEMO_EVENTS) return;
    const message = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
    const text = message?.type === "message" && message.message.role === "assistant"
      ? message.message.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
    appendFileSync(process.env.THREAD_DEMO_EVENTS, JSON.stringify({ session: ctx.sessionManager.getSessionId(), aborted: event.aborted, text }) + "\n");
  });
}
