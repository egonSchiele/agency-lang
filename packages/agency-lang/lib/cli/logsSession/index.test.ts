import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runViewer } from "@/logsViewer/run.js";
import { request } from "@/logsViewer/session/client.js";
import { listRecords, probeAll, recordPaths } from "@/logsViewer/session/registry.js";
import { loopEvents } from "@/logsViewer/storyFixture.js";
import { outlineRows } from "@/logsViewer/story.js";
import { buildForest } from "@/logsViewer/tree.js";
import { commentsPathFor } from "@/runDirectory/commentsPath.js";
import { openCommentsStore } from "@/runDirectory/commentsStore.js";
import { readTraces } from "@/runDirectory/traces.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";

import { defaultCommandDeps } from "./commands.js";
import { logsSession, type SessionCliDeps } from "./index.js";

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("agency logs session against a headless viewer", () => {
  let dir: string;
  let logPath: string;
  let sessions: string;
  let printed: string[];
  let deps: SessionCliDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsi-"));
    logPath = path.join(dir, "run.jsonl");
    fs.writeFileSync(
      logPath,
      loopEvents()
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    sessions = path.join(dir, "s");
    printed = [];
    deps = {
      sessionsDir: sessions,
      probe: (where) => probeAll(where, 500),
      commandDeps: defaultCommandDeps(request),
      targetDeps: {
        socketPathFor: (record) => recordPaths(sessions, record.pid).sock,
        openStore: openCommentsStore,
        cwd: dir,
        pathKind: (absolutePath) => (fs.existsSync(absolutePath) ? "file" : "missing"),
      },
      writeStdout: (text) => {
        printed.push(text);
      },
    };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("get and navigate go through the viewer, and comment add makes it show the mark", async () => {
    const store = openCommentsStore(commentsPathFor({ kind: "file", path: logPath }), {
      kind: "human",
      id: "adit",
    });
    const out = new FrameRecorder();
    const input = new ScriptedInput([]);
    const done = runViewer({
      jsonl: fs.readFileSync(logPath, "utf8"),
      followPath: logPath,
      session: { dir: sessions },
      comments: store,
      input,
      output: out,
      viewport: { rows: 24, cols: 130 },
    });
    await until(() => listRecords(sessions).length === 1);
    input.feedKey({ key: "2" });
    await until(() => out.lastText().includes("[2 trace]"));

    expect(await logsSession({ name: "get" }, { json: true }, deps)).toBe(0);
    const focus = JSON.parse(printed.at(-1)!) as { address: string; kind: string };
    expect(focus.kind).toBe("round");
    const trace = buildForest(readTraces(logPath).traces[0].events)[0];
    const tool = outlineRows(trace, { machinery: false, admin: false }).find(
      (row) => row.kind === "tool",
    )!;

    expect(
      await logsSession({ name: "navigate" }, { json: false, row: `T/${tool.id}` }, deps),
    ).toBe(0);
    expect(printed.at(-1)).toContain(`viewer moved to T/${tool.id}`);
    expect(await logsSession({ name: "get" }, { json: true }, deps)).toBe(0);
    expect((JSON.parse(printed.at(-1)!) as { kind: string }).kind).toBe("tool");

    // A person asks on the row; the agent answers through the CLI. The reply
    // always shows (an agent's own note would wait for C).
    const question = store.add({ traceId: "T", rowId: tool.id, anchor: {}, text: "why?" });
    expect(out.lastText()).not.toContain("from the cli");
    expect(
      await logsSession(
        { name: "comment add", text: "from the cli", replyTo: question.id },
        { json: false, row: `T/${tool.id}` },
        deps,
      ),
    ).toBe(0);
    await until(() => out.lastText().includes("from the cli"));
    expect(out.lastText()).toContain("✎");
    expect(out.lastText()).toContain("⚑ claude");

    expect(await logsSession({ name: "list" }, { json: false }, deps)).toBe(0);
    expect(printed.at(-1)).toContain("live");
    expect(printed.at(-1)).toContain(logPath);

    input.feedKey({ key: "q" });
    await done;
    expect(await logsSession({ name: "get" }, { json: false }, deps)).toBe(1);
    expect(printed.at(-1)).toContain("no viewer is open");
  });
});
