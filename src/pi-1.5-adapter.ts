import {
  AgentSession, VERSION, type BuildSystemPromptOptions, type InlineExtension,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isViewportTUI, type Component, type TUI, type ViewportTUI } from "@earendil-works/pi-tui";

// All reliance on non-public Pi fields is confined to this version-locked boundary.
interface SessionInternals {
  _bindExtensionCore: (...args: unknown[]) => unknown;
  _customTools: unknown[];
  _baseToolsOverride?: unknown;
  _baseSystemPromptOptions: BuildSystemPromptOptions;
}
interface LoaderInternals {
  extensionFactories: InlineExtension[];
  builtinExtensions: Map<string, InlineExtension>;
}
interface LayoutInternals extends ViewportTUI {
  layoutRoot?: Component;
  getFocusedComponent(): Component | null;
}

export function assertCompatible(): void {
  if (VERSION !== "1.5.0") throw new Error(`pi-thread requires Pi 1.5.0; found ${VERSION}. Adapter disabled.`);
}

const captureKey = Symbol.for("pi-thread.capture.1.5.0");
interface CaptureState {
  original: SessionInternals["_bindExtensionCore"];
  wrapped: SessionInternals["_bindExtensionCore"];
  sessions: WeakMap<object, AgentSession>;
}

export function captureMainSession() {
  assertCompatible();
  const prototype = AgentSession.prototype as unknown as SessionInternals & { [captureKey]?: CaptureState };
  let state = prototype[captureKey];
  if (!state) {
    const original = prototype._bindExtensionCore;
    if (typeof original !== "function") throw new Error("Unsupported Pi session binding shape.");
    const sessions = new WeakMap<object, AgentSession>();
    function wrapped(this: AgentSession, ...args: unknown[]) {
      sessions.set(this.sessionManager, this);
      return original.apply(this, args);
    }
    state = { original, wrapped, sessions };
    prototype[captureKey] = state;
    prototype._bindExtensionCore = wrapped;
  }
  const captured = state;
  const release = () => {
    if (prototype._bindExtensionCore === captured.wrapped) prototype._bindExtensionCore = captured.original;
    if (prototype[captureKey] === captured) delete prototype[captureKey];
  };
  return {
    take(manager: ExtensionContext["sessionManager"]): AgentSession {
      release();
      const session = captured.sessions.get(manager);
      if (!session) throw new Error("Could not attach to the Pi session. Reload pi-thread before opening a thread.");
      return session;
    },
    release,
  };
}

export function forkInputs(main: AgentSession) {
  assertCompatible();
  const internal = main as unknown as SessionInternals;
  const loader = main.resourceLoader as unknown as LoaderInternals;
  if (!Array.isArray(internal._customTools) || internal._customTools.length || internal._baseToolsOverride) {
    throw new Error("SDK-supplied tool closures cannot be safely forked. Use file-based tool extensions.");
  }
  if (!Array.isArray(loader.extensionFactories) || !(loader.builtinExtensions instanceof Map)) {
    throw new Error("Unsupported resource loader. A standard Pi resource loader is required.");
  }
  if (loader.extensionFactories.length) {
    throw new Error("Inline extension closures cannot be safely forked. Use file-based extensions.");
  }
  return {
    factories: [...loader.builtinExtensions.values()],
    prompt: structuredClone(internal._baseSystemPromptOptions),
  };
}

export function restorePrompt(session: AgentSession, prompt: BuildSystemPromptOptions): void {
  (session as unknown as SessionInternals)._baseSystemPromptOptions = structuredClone(prompt);
}

export function getMainLayout(tui: TUI) {
  assertCompatible();
  if (!isViewportTUI(tui)) throw new Error("pi-thread requires fullscreen mode (pi --tui-mode fullscreen).");
  const layout = tui as LayoutInternals;
  const root = layout.layoutRoot;
  const focus = layout.getFocusedComponent?.();
  if (!root || typeof root.render !== "function" || !focus) throw new Error("Unsupported Pi fullscreen layout shape.");
  return { root, focus };
}

export function mountSplit(tui: TUI, root: Component, onStop: () => void): () => void {
  const original = getMainLayout(tui);
  const viewport = tui as LayoutInternals;
  const stop = tui.stop;
  const wrappedStop: TUI["stop"] = function (options) {
    onStop();
    return stop.call(tui, options);
  };
  viewport.setLayoutRoot(root);
  tui.stop = wrappedStop;
  return () => {
    if (tui.stop === wrappedStop) tui.stop = stop;
    if (viewport.layoutRoot === root) viewport.setLayoutRoot(original.root);
    tui.setFocus(original.focus);
    tui.requestRender(true);
  };
}

export function getFocus(tui: TUI): Component | null {
  return (tui as LayoutInternals).getFocusedComponent();
}
