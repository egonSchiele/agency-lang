import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { commentsPathFor } from "./commentsPath.js";
import { openCommentsStore } from "./commentsStore.js";
import { runDirPaths } from "./runDir.js";
import { agentStartLine, tempDir } from "./testFixtures.js";

const adit = { kind: "human" as const, id: "adit" };
const draft = {
  traceId: "t1",
  rowId: "round:s1:0",
  anchor: { thread: "main", name: "gpt-5" },
  text: "why?",
};

describe("openCommentsStore", () => {
  it("appends under the run directory lock and reads the row back", () => {
    const dir = tempDir();
    fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1") + "\n");
    const store = openCommentsStore(commentsPathFor({ kind: "runDir", dir }), adit);
    expect(store.read().threads).toEqual([]);
    expect(store.changedSince()).toBe(false);

    const written = store.add(draft);
    expect(written.id).toMatch(/^c_/);
    expect(written.author).toEqual(adit);
    expect(store.changedSince()).toBe(true);
    const folded = store.read();
    expect(folded.threads.map((thread) => thread.comment.text)).toEqual(["why?"]);
    expect(store.changedSince()).toBe(false);
    expect(fs.existsSync(runDirPaths(dir).lock)).toBe(false);
  });

  it("locks a loose file's sidecar beside the sidecar, and leaves no lock behind", () => {
    const dir = tempDir("loose-");
    const statelog = path.join(dir, "run.jsonl");
    fs.writeFileSync(statelog, agentStartLine("t1") + "\n");
    const sidecar = commentsPathFor({ kind: "file", path: statelog });
    const store = openCommentsStore(sidecar, adit);
    store.add(draft);
    expect(fs.readdirSync(dir).sort()).toEqual(["run.jsonl", "run.jsonl.comments.jsonl"]);
    expect(store.read().threads).toHaveLength(1);
  });

  it("repairs a torn final line before appending", () => {
    const dir = tempDir();
    const store = openCommentsStore(commentsPathFor({ kind: "runDir", dir }), adit);
    const first = store.add(draft);
    fs.appendFileSync(store.path, '{"v":1,"id":"torn"');
    store.add({ ...draft, text: "second" });
    const texts = store.read().threads.map((thread) => thread.comment.text);
    expect(texts).toEqual(["why?", "second"]);
    expect(fs.readFileSync(store.path, "utf8")).toContain(first.id);
    expect(fs.readFileSync(store.path, "utf8")).not.toContain("torn");
  });
});
