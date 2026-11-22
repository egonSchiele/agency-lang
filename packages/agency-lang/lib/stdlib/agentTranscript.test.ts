import { describe, expect, it } from "vitest";
import { withEntry } from "./agentTranscript.js";

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("withEntry", () => {
  it("adds an entry to an existing list", () => {
    expect(withEntry([user("a")], assistant("b"))).toEqual([user("a"), assistant("b")]);
  });

  it("starts a list when the run has none", () => {
    expect(withEntry(null, user("new"))).toEqual([user("new")]);
  });

  it("adds nothing for an empty entry", () => {
    expect(withEntry([user("a")], assistant(""))).toEqual([user("a")]);
  });
});
