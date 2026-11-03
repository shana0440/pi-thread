import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Workspace, sleep } from "./workspace.mjs";

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const root = resolve(".agent/demo", new Date().toISOString().replaceAll(":", "-"));
await mkdir(`${root}/project`, { recursive: true });
await mkdir(`${root}/config`, { recursive: true });
await writeFile(`${root}/config/settings.json`, JSON.stringify({ theme: "dark", quietStartup: true, retry: { enabled: false } }));
const provider = process.env.PI_PROVIDER ?? "openai-codex";
const model = process.env.PI_MODEL ?? "gpt-6.1-sol";
const hostConfig = process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME, ".pi/agent");
const ffmpeg = process.env.FFMPEG ?? execFileSync("bash", ["-lc", "command -v ffmpeg || find /nix/store -maxdepth 3 -path '*/bin/ffmpeg' -print -quit 2>/dev/null"], { encoding: "utf8" }).trim();
if (!ffmpeg) throw new Error("Set FFMPEG to a usable ffmpeg binary.");
const workspace = new Workspace(`pi-thread-demo-${process.pid}`);
let recorder;
const steps = [];
async function events() {
  try { return (await readFile(`${root}/events.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function step(prompt, expected) {
  const before = (await events()).length;
  await workspace.submit(prompt);
  const deadline = Date.now() + 60_000;
  while (!(await events()).slice(before).some(event => !event.aborted && event.text.includes(expected))) {
    if (Date.now() > deadline) throw new Error(`No completed real-provider reply: ${expected}`);
    await sleep(200);
  }
  await workspace.wait(expected);
  await sleep(900);
  steps.push(expected);
}
try {
  const start = await workspace.start();
  await writeFile(`${root}/workspace-start.json`, JSON.stringify(start, null, 2));
  // Reuse existing OAuth without copying credentials into test artifacts. Remove the temporary
  // credential link (or any refreshed replacement) in finally; never read/log its contents.
  await symlink(resolve(hostConfig, "auth.json"), `${root}/config/auth.json`);
  const command = `cd ${quote(`${root}/project`)} && PI_CODING_AGENT_DIR=${quote(`${root}/config`)} THREAD_DEMO_EVENTS=${quote(`${root}/events.jsonl`)} pi --session-dir ${quote(`${root}/sessions`)} --provider ${quote(provider)} --model ${quote(model)} --thinking minimal --no-extensions --no-skills --no-prompt-templates --no-context-files --offline -e ${quote(resolve("src/index.ts"))} -e ${quote(resolve("test/e2e/observer.ts"))}`;
  await workspace.terminal(["bash", "-lc", command]);
  await workspace.resize(1850, 1000);
  await workspace.wait(model, 30_000);
  const result = await workspace.tool("workspace_launch_app", {
    name: "Pi thread demo recording",
    command: [ffmpeg, "-y", "-f", "x11grab", "-framerate", "15", "-video_size", "1920x1080", "-i", start.status.display,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${root}/demo.mp4`],
  });
  recorder = result.apps[0].id;
  await sleep(1000);
  await step("We are building pi-thread. The open/close shortcut is F7. Reply exactly: Ready to build pi-thread.", "Ready to build pi-thread.");
  await workspace.key("F7");
  await workspace.wait("Own context", 30_000);
  await sleep(1000);
  await step("What shortcut did we choose? Reply exactly: We chose F7.", "We chose F7.");
  await step("Remember the side-only code ORBIT-42. Reply exactly: Side code noted.", "Side code noted.");
  await workspace.key("F6");
  await sleep(700);
  await step("Did I give you a code in this conversation? If not, reply exactly: No code in main.", "No code in main.");
  await workspace.key("F6");
  await step("Use write to create note.txt containing exactly 'side thread wrote this'. Then reply exactly: File written from side.", "File written from side.");
  await workspace.key("F6");
  await step("Use read to read note.txt. Reply with its contents only.", "side thread wrote this");
  await workspace.tool("workspace_screenshot", { output_path: `${root}/split.png` });
  await sleep(1500);
  await workspace.key("F7");
  await sleep(1500);
  await workspace.key("F7");
  await workspace.wait("Own context", 30_000);
  await step("Has a side-only code been provided in your conversation? Reply exactly: No side code.", "No side code.");
  await workspace.key("F7");
  await sleep(2000);
  await workspace.tool("workspace_kill_app", { app_id: recorder });
  recorder = undefined;
  await sleep(500);
  const probe = execFileSync(resolve(dirname(ffmpeg), "ffprobe"), ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", `${root}/demo.mp4`], { encoding: "utf8" });
  await writeFile(`${root}/video-info.json`, probe);
  await writeFile(`${root}/steps.json`, JSON.stringify(steps, null, 2));
  await workspace.key("C-d");
  console.log(`Real-provider recording: ${root}/demo.mp4`);
} catch (error) {
  await writeFile(`${root}/failure.txt`, String(error.stack ?? error));
  try { await writeFile(`${root}/failure-screen.txt`, await workspace.read()); } catch {}
  throw error;
} finally {
  if (recorder) { try { await workspace.tool("workspace_kill_app", { app_id: recorder }); } catch {} }
  await workspace.stop();
  await rm(`${root}/config/auth.json`, { force: true });
}
