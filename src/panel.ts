import {
  getMarkdownTheme, getSelectListTheme, type AgentSession, type AgentSessionEvent,
  type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor, HStack, Markdown, ScrollView, VStack, matchesKey, truncateToWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { getFocus, getMainLayout, mountSplit } from "./pi-1.5-adapter.ts";

function dynamic(render: (width: number) => string[]): Component {
  return { render, invalidate() {} };
}

export class ThreadPanel extends VStack implements Focusable {
  readonly capturesViewportInput = true;
  readonly editor: Editor;
  readonly scroll: ScrollView;
  private active = false;
  private busy = false;
  private status = "Opening isolated thread…";
  private messages: AgentSession["messages"] = [];
  private historyCount = 0;
  private live = true;
  private unsubscribe?: () => void;
  private removeInput?: () => void;
  private restore?: () => void;
  private session?: AgentSession;
  private cached?: { width: number; revision: number; lines: string[] };
  private messageCache = new WeakMap<object, { width: number; lines: string[] }>();
  private revision = 0;
  private mainFocus?: Component;
  private onClose: () => void;

  constructor(private tui: TUI, private theme: () => Theme, onClose: () => void) {
    super();
    this.onClose = onClose;
    this.editor = new Editor(tui, {
      borderColor: text => theme().fg(this.active ? "accent" : "borderMuted", text),
      selectList: getSelectListTheme(),
    }, { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.onSubmit = text => { void this.submit(text); };
    this.scroll = new ScrollView(dynamic(width => this.renderMessages(width)), { follow: "end", overscroll: "contain" });
    this.addChild(dynamic(width => [truncateToWidth(theme().fg(this.active ? "accent" : "muted", ` ${this.active ? "●" : "○"} SIDE THREAD · ${this.session?.model?.id ?? "opening"}`), width)]), { basis: 1 });
    this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(dynamic(width => [truncateToWidth(theme().fg("dim", ` ${this.status.replace(/\s+/g, " ")}`), width)]), { basis: 1 });
    this.addChild(this.editor, { minSize: 3, maxSize: 8, shrink: 1 });
    this.addChild(dynamic(width => [truncateToWidth(theme().fg("dim", " F6 switch · F7 close · Esc stop · PgUp/PgDn scroll"), width)]), { basis: 1 });
  }

  get focused() { return this.active; }
  set focused(value: boolean) { this.active = value; this.editor.focused = value; }

  mount(): void {
    const { root, focus } = getMainLayout(this.tui);
    this.mainFocus = focus;
    const main = new VStack([
      { component: dynamic(width => [truncateToWidth(this.theme().fg(this.active ? "muted" : "accent", ` ${this.active ? "○" : "●"} MAIN · ${this.tui.terminal.columns < 100 ? "narrow screen · " : ""}F6 switch · F7 close thread`), width)]), basis: 1 },
      { component: root, basis: 0, grow: 1 },
    ]);
    const split = new HStack([
      { component: main, basis: 0, grow: 2, minSize: 1, visible: viewport => viewport.width >= 100 || !this.active },
      { component: dynamic(() => Array.from({ length: this.tui.terminal.rows }, () => this.theme().fg("borderMuted", "│"))), basis: 1, visible: viewport => viewport.width >= 100 },
      { component: this, basis: 0, grow: 3, minSize: 1, visible: viewport => viewport.width >= 100 || this.active },
    ]);
    this.restore = mountSplit(this.tui, split, this.onClose);
    this.removeInput = this.tui.addInputListener(data => {
      if (this.tui.hasOverlay()) return;
      if (matchesKey(data, "f7")) { this.onClose(); return { consume: true }; }
      if (matchesKey(data, "f6")) { this.toggleFocus(); return { consume: true }; }
      // Only the actual side focus owner may consume editor input.
      if (getFocus(this.tui) === this && matchesKey(data, "ctrl+d") && !this.editor.getText()) {
        this.onClose(); return { consume: true };
      }
    });
    this.tui.setFocus(this);
    this.tui.requestRender(true);
  }

  attach(session: AgentSession): void {
    if (!this.live) return;
    this.session = session;
    this.messages = [...session.messages];
    this.historyCount = this.messages.length;
    this.status = "Own context · shared files · ready";
    this.editor.disableSubmit = false;
    this.unsubscribe = session.subscribe(event => this.onEvent(event));
    this.changed();
    this.scroll.scrollToEnd();
  }

  private onEvent(event: AgentSessionEvent): void {
    if (!this.live) return;
    if (event.type === "message_start") this.messages.push(event.message);
    else if (event.type === "message_update" || event.type === "message_end") {
      this.messageCache.delete(event.message);
      const last = this.messages.at(-1);
      if (last?.role === event.message.role && last.timestamp === event.message.timestamp) this.messages[this.messages.length - 1] = event.message;
      else this.messages.push(event.message);
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) this.status = event.message.errorMessage;
    } else if (event.type === "tool_execution_start") this.status = `Running ${event.toolName}…`;
    else if (event.type === "tool_execution_end") this.status = `${event.toolName}: ${event.isError ? "error" : "done"}`;
    else if (event.type === "auto_retry_start") this.status = `Retrying (${event.attempt})…`;
    this.changed();
  }

  private async submit(text: string): Promise<void> {
    if (!text.trim() || !this.session || !this.live || this.busy) return;
    if (text.trim() === "/close" || text.trim() === "/thread") { this.onClose(); return; }
    // Interactive-mode builtins switch/replace the main session; never dispatch those from this pane.
    if (/^\/(new|resume|reload|fork|clone|tree|settings|model)(\s|$)/.test(text.trim())) {
      this.status = "Use main for session/settings commands. F7 closes this thread.";
      this.changed(); return;
    }
    this.busy = true;
    this.editor.disableSubmit = true;
    this.editor.setText("");
    this.editor.addToHistory(text);
    this.scroll.scrollToEnd();
    this.status = "Thinking…";
    this.changed();
    const previousCount = this.messages.length;
    try { await this.session.prompt(text); }
    catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      if (this.live && this.messages.length === previousCount && !this.editor.getText()) this.editor.setText(text);
    }
    finally {
      this.busy = false;
      this.editor.disableSubmit = !this.live;
      if (this.status === "Thinking…" || this.status.endsWith(": done")) this.status = "Own context · shared files · ready";
      this.changed();
    }
  }

  handleInput(data: string): void {
    if (!this.live) return;
    if (matchesKey(data, "escape")) {
      if (this.busy) { this.status = "Stopping…"; void this.session?.abort(); this.changed(); }
    } else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 2));
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 2));
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
    const result = super.handleMouse(event);
    return result?.focus ? { ...result, focusTarget: this } : result;
  }

  toggleFocus(): void {
    this.tui.setFocus(getFocus(this.tui) === this ? this.mainFocus ?? null : this);
    this.tui.requestRender(true);
  }

  private changed(): void {
    this.revision++;
    if (this.live) this.tui.requestRender();
  }

  private renderMessages(width: number): string[] {
    if (this.cached?.width === width && this.cached.revision === this.revision) return this.cached.lines;
    const lines: string[] = [];
    const markdownTheme = getMarkdownTheme();
    for (let index = 0; index < this.messages.length; index++) {
      if (index === this.historyCount) lines.push(this.theme().fg("accent", " ── Fork point · messages below stay here ──"));
      const message = this.messages[index]!;
      if (message.role === "system") continue;
      const cached = this.messageCache.get(message);
      if (cached?.width === width && !(this.busy && index === this.messages.length - 1)) {
        lines.push(...cached.lines, "");
        continue;
      }
      let label: string;
      let content: string;
      if (message.role === "user") {
        label = "You";
        content = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      } else if (message.role === "assistant") {
        label = "Pi";
        content = message.content.map(block => block.type === "text" ? block.text : block.type === "toolCall" ? `\n**${block.name}** \`${JSON.stringify(block.arguments)}\`` : "").join("");
        if (message.errorMessage) content += `\n${message.errorMessage}`;
      } else if (message.role === "toolResult") {
        label = `${message.toolName} ${message.isError ? "✗" : "✓"}`;
        content = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (content.length > 4000) content = content.slice(0, 4000) + "\n[Display truncated; full result remains in thread context.]";
      } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
        label = "Earlier context"; content = message.summary;
      } else if (message.role === "custom" && message.display) {
        label = message.customType;
        content = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      } else continue;
      const rendered = new Markdown(`**${label}**\n\n${content}`, 1, 0, markdownTheme).render(width);
      this.messageCache.set(message, { width, lines: rendered });
      lines.push(...rendered, "");
    }
    if (!this.messages.length || this.historyCount === this.messages.length) {
      lines.push(...new Markdown("*Forked from main. Ask a clarification here; nothing is sent back.*", 1, 0, markdownTheme).render(width));
    }
    this.cached = { width, revision: this.revision, lines };
    return lines;
  }

  sideUI(main: ExtensionUIContext): ExtensionUIContext {
    const dialogNames = new Set(["select", "confirm", "input", "editor", "custom"]);
    const panel = this;
    return new Proxy(main, {
      get(target, key, receiver) {
        if (key === "theme") return panel.theme();
        if (key === "getEditorText") return () => panel.editor.getText();
        if (key === "setEditorText") return (text: string) => { panel.editor.setText(text); panel.changed(); };
        if (key === "pasteToEditor") return (text: string) => { panel.editor.insertTextAtCursor(text); panel.changed(); };
        if (key === "notify") return (text: string) => { panel.status = text; panel.changed(); };
        if (key === "setStatus") return (_name: string, text?: string) => { panel.status = text ?? "Ready"; panel.changed(); };
        if (dialogNames.has(String(key))) {
          return async (...args: unknown[]) => {
            const focus = getFocus(panel.tui);
            try { return await (Reflect.get(target, key) as (...args: unknown[]) => unknown)(...args); }
            finally { if (panel.live) { panel.tui.setFocus(focus); panel.tui.requestRender(); } }
          };
        }
        // Presentation-only extensions must not replace main's editor/header/widgets or input listeners.
        if (/^(set|onTerminalInput|addAutocomplete)/.test(String(key))) return () => {};
        return Reflect.get(target, key, receiver);
      },
    });
  }

  invalidate(): void {
    this.cached = undefined;
    this.messageCache = new WeakMap();
    super.invalidate();
  }

  dispose(): void {
    if (!this.live) return;
    this.live = false;
    this.unsubscribe?.();
    this.removeInput?.();
    this.restore?.();
    this.messages = [];
    this.session = undefined;
    this.cached = undefined;
    this.messageCache = new WeakMap();
  }
}
