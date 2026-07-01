import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { promptText, redactMessagesForLog } from "./prompt.js";
import { MessageThread } from "./state/messageThread.js";

describe("promptText", () => {
  it("returns a plain string unchanged", () => {
    expect(promptText("hello")).toBe("hello");
  });

  it("joins text parts and bare strings, dropping attachments", () => {
    const p = [
      "describe this",
      { type: "image", source: { kind: "path", path: "./cat.png" } },
      { type: "text", text: "and this" },
    ] as smoltalk.UserContentInput;
    expect(promptText(p)).toBe("describe this and this");
  });
});

describe("redactMessagesForLog", () => {
  it("redacts base64 attachment payloads but keeps structure", () => {
    const thread = new MessageThread();
    thread.push(
      smoltalk.userMessage([
        "look",
        {
          type: "image",
          source: {
            kind: "base64",
            base64: "A".repeat(5000),
            mimeType: "image/png",
          },
        },
      ] as smoltalk.UserContentInput),
    );
    const redacted = JSON.stringify(redactMessagesForLog(thread));
    expect(redacted).not.toContain("A".repeat(5000)); // the blob is gone
    expect(redacted).toContain("image/png"); // structure is kept
  });

  it("leaves a plain string message intact", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("just text"));
    expect(JSON.stringify(redactMessagesForLog(thread))).toContain("just text");
  });
});
