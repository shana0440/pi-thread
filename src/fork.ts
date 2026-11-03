import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager,
  SettingsManager, type AgentSession, type ExtensionUIContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { forkInputs, restorePrompt } from "./pi-1.5-adapter.ts";

export interface SideSession {
  session: AgentSession;
  close(): Promise<void>;
}

export async function forkSession(main: AgentSession, ownPath: string, ui: ExtensionUIContext): Promise<SideSession> {
  if (!main.isIdle || main.isCompacting || main.pendingMessageCount) {
    throw new Error("Wait for the main conversation to finish before opening a thread.");
  }
  if (!main.model) throw new Error("Select a model before opening a thread.");
  const inputs = forkInputs(main);
  const cwd = main.sessionManager.getCwd();
  const source = main.resourceLoader;
  const model = main.model;
  const thinkingLevel = main.thinkingLevel;
  const active = main.getActiveToolNames();
  const expected = main.getAllTools().filter(tool => tool.exposure !== "hidden");
  const hidden = main.getAllTools().filter(tool => tool.exposure === "hidden").map(tool => tool.name);
  const flags = main.extensionRunner.getFlagValues();
  const resourceSnapshot = {
    skills: source.getSkills(), prompts: source.getPrompts(), themes: source.getThemes(),
    agentsFiles: source.getAgentsFiles(), systemPrompt: source.getSystemPrompt(),
    systemPromptSource: source.getSystemPromptSource(), appendSystemPrompt: source.getAppendSystemPrompt(),
    appendSystemPromptSources: source.getAppendSystemPromptSources(),
  };
  const ownFile = realpathSync(ownPath);
  const paths = main.extensionRunner.getExtensionPaths().filter(path => path.startsWith("builtin:") || realpathSync(path) !== ownFile);
  const header = main.sessionManager.getHeader();
  if (!header) throw new Error("The main session has no history header.");
  // Preserve entry ids and parent links, but use a distinct identity for cancellation/cache/resources.
  const entries = structuredClone([
    { ...header, id: randomUUID(), timestamp: new Date().toISOString() },
    ...main.sessionManager.getBranch(),
  ]);
  const manager = SessionManager.inMemory(cwd, undefined, entries);
  const settings = SettingsManager.inMemory(main.settingsManager.getSettings(), {
    projectTrusted: main.settingsManager.isProjectTrusted(),
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    additionalExtensionPaths: paths, extensionFactories: inputs.factories,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(`Side extensions failed: ${errors.map(error => error.error).join("; ")}`);
  for (const [name, value] of flags) loader.getExtensions().runtime.flagValues.set(name, value);
  // New factories/extension API bindings, but the exact resource snapshot from the fork point.
  const resources: ResourceLoader = {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => resourceSnapshot.skills, getPrompts: () => resourceSnapshot.prompts, getThemes: () => resourceSnapshot.themes,
    getAgentsFiles: () => resourceSnapshot.agentsFiles, getSystemPrompt: () => resourceSnapshot.systemPrompt,
    getSystemPromptSource: () => resourceSnapshot.systemPromptSource,
    getAppendSystemPrompt: () => resourceSnapshot.appendSystemPrompt,
    getAppendSystemPromptSources: () => resourceSnapshot.appendSystemPromptSources,
    extendResources: () => {}, reload: async () => { throw new Error("Close and reopen the thread to reload resources."); },
  };
  const runtime = await ModelRuntime.create();
  for (const id of main.modelRuntime.getRegisteredProviderIds()) {
    const native = main.modelRuntime.getRegisteredNativeProvider(id);
    const config = main.modelRuntime.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(id, config);
  }
  const auth = await main.modelRuntime.getAuth(model);
  // OAuth access tokens are not API-key credentials. Replacing the side credential with
  // an api_key entry disables OAuth-only providers (including openai-codex).
  if (auth?.auth.apiKey && !main.modelRuntime.isUsingOAuth(model.provider)) {
    await runtime.setRuntimeApiKey(model.provider, auth.auth.apiKey);
  }
  const { session } = await createAgentSession({
    cwd, modelRuntime: runtime, model, thinkingLevel,
    sessionManager: manager, settingsManager: settings, resourceLoader: resources,
    excludeTools: hidden,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await session.abort(); }
    finally {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    }
  };
  let initializing = true;
  const initializationErrors: string[] = [];
  try {
    await session.bindExtensions({
      uiContext: ui, mode: "tui", shutdownHandler: () => { void close(); },
      onError: error => {
        const message = `${error.extensionPath}: ${error.error}`;
        if (initializing) initializationErrors.push(message);
        ui.notify(message, "error");
      },
    });
    // MCP servers can connect asynchronously. Let the same tool_call hooks resolve deferred tools.
    // Require all already-visible main declarations, allowing a bounded connection window.
    const deadline = Date.now() + 10_000;
    while (expected.some(tool => tool.name.startsWith("mcp__") && !session.getAllTools().some(candidate => candidate.name === tool.name)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const actual = new Map(session.getAllTools().map(tool => [tool.name, tool]));
    for (const tool of expected) {
      const copy = actual.get(tool.name);
      if (!copy || copy.exposure !== tool.exposure || JSON.stringify(copy.parameters) !== JSON.stringify(tool.parameters) || copy.description !== tool.description) {
        throw new Error(`Cannot safely reproduce tool ${tool.name}. Thread was not opened.`);
      }
    }
    const extras = [...actual.values()].filter(tool => tool.exposure !== "hidden" && !expected.some(original => original.name === tool.name));
    if (extras.length) throw new Error(`Side exposes additional tools: ${extras.map(tool => tool.name).join(", ")}. Thread was not opened.`);
    session.setActiveToolsByName(active);
    if (JSON.stringify([...session.getActiveToolNames()].sort()) !== JSON.stringify([...active].sort())) {
      throw new Error("Side tool selection differs from main. Thread was not opened.");
    }
    if (initializationErrors.length) throw new Error(`Side extension initialization failed: ${initializationErrors.join("; ")}`);
    restorePrompt(session, inputs.prompt);
    initializing = false;
    return { session, close };
  } catch (error) { await close(); throw error; }
}
