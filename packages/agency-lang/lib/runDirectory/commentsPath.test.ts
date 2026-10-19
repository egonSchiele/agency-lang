import * as path from "path";

import { describe, expect, it } from "vitest";

import { commentsLockFor, commentsPathFor } from "./commentsPath.js";

describe("commentsPathFor", () => {
  it("puts a run directory's comments beside its notes, and a loose file's in a sidecar", () => {
    expect(commentsPathFor({ kind: "runDir", dir: "/runs/k3Pq9abc" })).toBe(
      path.join("/runs/k3Pq9abc", "comments.jsonl"),
    );
    expect(commentsPathFor({ kind: "file", path: "/logs/run.jsonl" })).toBe(
      "/logs/run.jsonl.comments.jsonl",
    );
  });

  it("locks a run directory's comments with its .lock and a sidecar with its own", () => {
    expect(commentsLockFor(path.join("/runs/k3Pq9abc", "comments.jsonl"))).toBe(
      path.join("/runs/k3Pq9abc", ".lock"),
    );
    expect(commentsLockFor("/logs/run.jsonl.comments.jsonl")).toBe(
      "/logs/run.jsonl.comments.jsonl.lock",
    );
  });
});
