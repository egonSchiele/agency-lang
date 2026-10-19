import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loopEvents } from "@/logsViewer/storyFixture.js";
import { outlineRows } from "@/logsViewer/story.js";
import { buildForest } from "@/logsViewer/tree.js";
import type { SessionRequest } from "@/logsViewer/session/protocol.js";
import { commentsPathFor } from "@/runDirectory/commentsPath.js";
import { openCommentsStore } from "@/runDirectory/commentsStore.js";
import { readTraces } from "@/runDirectory/traces.js";

import { commentAdd, comments, get, list, navigate, show, type CommandDeps } from "./commands.js";
import type { Target } from "./target.js";

/** A loose statelog with two traces, T and U, each the story fixture's loop. */
function writeLog(dir: string): string {
  const file = path.join(dir, "run.jsonl");
  const lines = ["T", "U"].flatMap((traceId) =>
    loopEvents().map((event) => JSON.stringify({ ...event, trace_id: traceId })),
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("the session commands on a files target", () => {
  let dir: string;
  let logPath: string;
  let target: Extract<Target, { kind: "files" }>;
  let requests: SessionRequest[];
  let deps: CommandDeps;
  let roundId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsc-"));
    logPath = writeLog(dir);
    requests = [];
    deps = {
      readLog: (file) => readTraces(file).traces,
      request: async (_socket, req) => {
        requests.push(req);
        return { ok: true };
      },
    };
    const store = openCommentsStore(commentsPathFor({ kind: "file", path: logPath }), {
      kind: "agent",
      id: "claude",
    });
    target = { kind: "files", logPath, store, traceId: undefined, rowRef: undefined };
    const trace = buildForest(readTraces(logPath).traces[0].events)[0];
    roundId = outlineRows(trace, { machinery: false, admin: false }).find(
      (row) => row.kind === "round",
    )!.id;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("get and navigate need a viewer", async () => {
    expect(get(target, deps)).toMatchObject({ exitCode: 1 });
    expect(get(target, deps).text).toContain("no viewer is open");
    expect(await navigate({ ...target, rowRef: roundId, traceId: "T" }, deps)).toMatchObject({
      exitCode: 1,
    });
  });

  it("show expands a row by address, and a bare row id with no trace is refused with the ids", () => {
    const byAddress = show({ ...target, rowRef: `T/${roundId}` }, deps);
    expect(byAddress.exitCode).toBe(0);
    expect(byAddress.text.split("\n")[0]).toBe(`T/${roundId}`);
    const shown = show({ ...target, traceId: "T", rowRef: roundId }, deps);
    expect(shown.exitCode).toBe(0);
    expect(shown.text.split("\n")[0]).toBe(`T/${roundId}`);
    expect(shown.text).toContain("LLM call 1 of");
    expect((shown.json as { events: unknown[] }).events.length).toBeGreaterThan(0);

    const bare = show({ ...target, rowRef: roundId }, deps);
    expect(bare.exitCode).toBe(1);
    expect(bare.text).toContain("T, U");
    expect(show({ ...target, traceId: "T", rowRef: "nope" }, deps).text).toContain("no row nope");
    expect(show({ ...target, traceId: "zz", rowRef: roundId }, deps).text).toContain("no trace zz");
  });

  it("comment add writes through the store and comments lists it with its row expanded", async () => {
    const added = await commentAdd(
      { ...target, traceId: "T", rowRef: roundId },
      "why this call?",
      {},
      deps,
    );
    expect(added.exitCode).toBe(0);
    expect(added.text).toContain(`on T/${roundId}`);
    expect(requests).toEqual([]);

    const listed = comments(target, false, deps);
    expect(listed.exitCode).toBe(0);
    expect(listed.text).toContain(`T/${roundId}`);
    expect(listed.text).toContain("why this call?");
    expect(listed.text).toContain("LLM call 1 of");
    expect((listed.json as { resolved: boolean }[])[0].resolved).toBe(true);

    const reply = await commentAdd(
      { ...target, traceId: "T", rowRef: roundId },
      "it retries",
      { replyTo: (added.json as { id: string }).id },
      deps,
    );
    expect((reply.json as { replyTo: string }).replyTo).toBe((added.json as { id: string }).id);
    expect(comments(target, false, deps).text).toContain("it retries");
  });

  it("with no viewer, comments lists every trace; --trace narrows it", async () => {
    await commentAdd({ ...target, traceId: "T", rowRef: roundId }, "on T", {}, deps);
    await commentAdd({ ...target, traceId: "U", rowRef: roundId }, "on U", {}, deps);
    const every = comments(target, false, deps);
    expect(every.text).toContain("on T");
    expect(every.text).toContain("on U");
    const narrowed = comments({ ...target, traceId: "U" }, false, deps);
    expect(narrowed.text).toContain("on U");
    expect(narrowed.text).not.toContain("on T");
    expect(comments({ ...target, traceId: "U" }, true, deps).text).toContain("on T");
  });

  it("a comment whose row no longer resolves is listed by its anchor, not dropped", () => {
    target.store.add({
      traceId: "T",
      rowId: "round:gone:9",
      anchor: { thread: "reviewer", name: "gpt-5" },
      text: "where did this go?",
    });
    const listed = comments(target, false, deps);
    expect(listed.text).toContain("re-anchored");
    expect(listed.text).toContain("reviewer · gpt-5");
    expect(listed.text).toContain("where did this go?");
    expect((listed.json as { resolved: boolean }[])[0].resolved).toBe(false);
  });

  it("--reply-to must name a comment on the same row", async () => {
    const first = await commentAdd({ ...target, traceId: "T", rowRef: roundId }, "on T", {}, deps);
    const firstId = (first.json as { id: string }).id;
    const typo = await commentAdd(
      { ...target, traceId: "T", rowRef: roundId },
      "reply",
      { replyTo: "c_nope" },
      deps,
    );
    expect(typo.exitCode).toBe(1);
    expect(typo.text).toContain("no comment c_nope");
    const elsewhere = await commentAdd(
      { ...target, traceId: "U", rowRef: roundId },
      "reply",
      { replyTo: firstId },
      deps,
    );
    expect(elsewhere.exitCode).toBe(1);
    expect(elsewhere.text).toContain(`is on T/${roundId}`);
    expect(target.store.read().threads).toHaveLength(1);
  });

  it("the readable comments output carries each comment's id, for --reply-to", async () => {
    const added = await commentAdd({ ...target, traceId: "T", rowRef: roundId }, "why?", {}, deps);
    expect(comments(target, false, deps).text).toContain((added.json as { id: string }).id);
  });

  it("a reload the viewer does not answer leaves the write reported as saved", async () => {
    const stalled: CommandDeps = {
      ...deps,
      request: async () => {
        throw new Error("closed without a reply");
      },
    };
    const session: Target = {
      kind: "session",
      session: {
        record: { pid: 1, logPath, commentsPath: target.store.path, cwd: "/", started: "" },
        focus: { traceId: "T", screen: "trace", rowId: roundId, logPath, commentsPath: undefined },
        socketPath: "/nowhere.sock",
      },
      store: target.store,
      traceId: "T",
      rowRef: roundId,
    };
    const result = await commentAdd(session, "still saved", {}, stalled);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("saved");
    expect(result.text).toContain("did not reload");
    expect(target.store.read().threads).toHaveLength(1);
  });

  it("comment add refuses an unknown row and writes nothing", async () => {
    const result = await commentAdd({ ...target, traceId: "T", rowRef: "nope" }, "x", {}, deps);
    expect(result.exitCode).toBe(1);
    expect(target.store.read().threads).toEqual([]);
  });

  it("list shows each viewer's state", () => {
    expect(list([]).text).toBe("no viewers are open");
    const text = list([
      {
        record: { pid: 1, logPath: "/logs/a.jsonl", cwd: "/", started: "" },
        result: {
          state: "live",
          focus: {
            traceId: "T",
            screen: "trace",
            rowId: "r",
            logPath: "/logs/a.jsonl",
            commentsPath: undefined,
          },
        },
      },
      {
        record: { pid: 2, logPath: "/logs/b.jsonl", cwd: "/", started: "" },
        result: { state: "not-responding" },
      },
    ]).text;
    expect(text).toContain("1\tlive");
    expect(text).toContain("T/r");
    expect(text).toContain("2\tnot-responding");
  });
});
