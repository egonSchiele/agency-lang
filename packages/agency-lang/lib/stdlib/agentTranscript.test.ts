import { describe, expect, it } from "vitest";
import { withEntry } from "./agentTranscript.js";

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("withEntry", () => {
  it("adds an entry to an existing list and ignores the thread", () => {
    expect(withEntry([user("a")], [{ role: "user", content: "old" }], assistant("b"))).toEqual([
      user("a"),
      assistant("b"),
    ]);
  });

  it("starts a missing list from the thread's messages", () => {
    const thread = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ];
    expect(withEntry(null, thread, user("new"))).toEqual([
      user("old question"),
      assistant("old answer"),
      user("new"),
    ]);
  });

  it("adds nothing for an empty entry", () => {
    expect(withEntry([user("a")], [], assistant(""))).toEqual([user("a")]);
  });
});
