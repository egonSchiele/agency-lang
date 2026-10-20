import { describe, expect, it } from "vitest";

import type { PayloadLine } from "./payload.js";
import { payloadText } from "./payloadText.js";

describe("payloadText", () => {
  it("renders one case per kind and skips charts", () => {
    const lines: PayloadLine[] = [
      { kind: "heading", text: "ASSISTANT", tone: "assistant" },
      { kind: "meta", text: "2.1s" },
      { kind: "rule", text: "RESULT", tone: "tool" },
      { kind: "text", text: "two\nlines", indent: 1, role: "plain" },
      { kind: "pair", key: "path", text: "config/app.json", indent: 0 },
      { kind: "table", columns: ["a", "b"], rows: [["1", "2"]], indent: 1 },
      { kind: "code", text: "let x = 1", language: "agency" },
      { kind: "json", text: "{}" },
      { kind: "charts", calls: [] },
      { kind: "blank" },
    ];
    expect(payloadText(lines)).toBe(
      [
        "ASSISTANT",
        "2.1s",
        "── RESULT ──",
        "  two",
        "  lines",
        "path: config/app.json",
        "  a | b",
        "  1 | 2",
        "let x = 1",
        "{}",
        "",
      ].join("\n"),
    );
  });
});
