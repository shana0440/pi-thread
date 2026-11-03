import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { captureMainSession, getMainLayout } from "./pi-1.5-adapter.ts";
import { forkSession, type SideSession } from "./fork.ts";
import { ThreadPanel } from "./panel.ts";

interface Thread {
  panel: ThreadPanel;
  side?: SideSession;
  opening?: Promise<void>;
}

export default function threadExtension(pi: ExtensionAPI) {
  let capture: ReturnType<typeof captureMainSession> | undefined;
  let compatibilityError: string | undefined;
  try { capture = captureMainSession(); }
  catch (error) { compatibilityError = String(error); }
  let main: AgentSession | undefined;
  let tui: TUI | undefined;
  let current: Thread | undefined;
  let closing: Promise<void> | undefined;
  const ownPath = fileURLToPath(import.meta.url);

  async function close(): Promise<void> {
    const thread = current;
    if (!thread) { await closing; return; }
    current = undefined;
    thread.panel.dispose();
    closing = (async () => {
      await thread.opening;
      await thread.side?.close();
    })();
    try { await closing; }
    finally { closing = undefined; }
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (current) { await close(); return; }
    if (closing) { ctx.ui.notify("Thread is still closing; try again shortly.", "info"); return; }
    try {
      if (compatibilityError) throw new Error(compatibilityError);
      if (ctx.mode !== "tui" || !tui || !main) throw new Error("pi-thread requires interactive fullscreen Pi.");
      if (!ctx.isIdle() || main.isCompacting || ctx.hasPendingMessages()) throw new Error("Wait for the main conversation to finish before opening a thread.");
      if (tui.terminal.columns < 100 || tui.terminal.rows < 12) throw new Error("Opening a split requires at least 100 columns and 12 rows. Enlarge the terminal first.");
      getMainLayout(tui);
      const panel = new ThreadPanel(tui, () => ctx.ui.theme, () => { void close().catch(error => ctx.ui.notify(String(error), "error")); });
      const thread: Thread = { panel };
      current = thread;
      panel.mount();
      thread.opening = (async () => {
        const side = await forkSession(main!, ownPath, panel.sideUI(ctx.ui));
        thread.side = side;
        if (current === thread) panel.attach(side.session);
        else await side.close();
      })();
      await thread.opening;
    } catch (error) {
      // Do not await the failed opening promise again in close().
      const thread = current;
      if (thread) { current = undefined; thread.panel.dispose(); await thread.side?.close(); }
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (capture) {
      try { main = capture.take(ctx.sessionManager); }
      catch (error) { compatibilityError = String(error); }
    }
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("pi-thread-host", activeTui => {
      tui = activeTui;
      return { render: () => [], invalidate() {} };
    });
  });
  pi.on("session_shutdown", async () => { capture?.release(); await close(); });
  pi.registerCommand("thread", {
    description: "Fork main into a disposable right-side thread; repeat to close. F6 switches focus, F7 toggles.",
    handler: async (_args, ctx) => { await toggle(ctx); },
  });
  pi.registerShortcut("f7", { description: "Open/close side thread", handler: toggle });
  pi.registerShortcut("f6", {
    description: "Switch main/side focus",
    handler: ctx => {
      if (current) current.panel.toggleFocus();
      else ctx.ui.notify("Open a side thread with /thread or F7 first.", "info");
    },
  });
}
