import { describe, it, expect } from "vitest";
import {
  createCapture,
  describeReply,
  describeRequest,
  serveLogLines,
  type LogEntry,
} from "./serveLog.js";
import { color, plainColor } from "../utils/termcolors.js";

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    model: "org/a",
    status: 200,
    durationMs: 1400,
    request: null,
    reply: null,
    ...over,
  };
}

describe("describeRequest", () => {
  it("indents the body it was given", () => {
    expect(describeRequest({ model: "org/a", messages: [{ role: "user", content: "hi" }] })).toBe(
      [
        "{",
        '  "model": "org/a",',
        '  "messages": [',
        "    {",
        '      "role": "user",',
        '      "content": "hi"',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("is null for an empty body", () => {
    expect(describeRequest({})).toBe(null);
  });
});

describe("describeReply", () => {
  it("indents a JSON reply and reads its usage", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 312, completion_tokens: 180 },
    });
    const summary = describeReply(body, "application/json", false);
    expect(summary.promptTokens).toBe(312);
    expect(summary.completionTokens).toBe(180);
    expect(summary.streamed).toBe(false);
    expect(summary.body).toBe(JSON.stringify(JSON.parse(body), null, 2));
  });

  it("leaves a stream exactly as it came, and finds the usage in it", () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const summary = describeReply(body, "text/event-stream", false);
    expect(summary.body).toBe(body);
    expect(summary.streamed).toBe(true);
    expect(summary.promptTokens).toBe(3);
    expect(summary.completionTokens).toBe(2);
  });

  it("keeps a body that is not JSON, with no counts", () => {
    const summary = describeReply("Internal Server Error", "text/plain", false);
    expect(summary.body).toBe("Internal Server Error");
    expect(summary.promptTokens).toBeUndefined();
  });

  it("carries the truncated flag through", () => {
    expect(describeReply("half a re", "text/plain", true).truncated).toBe(true);
  });
});

describe("createCapture", () => {
  it("keeps the bytes it is given", () => {
    const capture = createCapture(100);
    capture.push(Buffer.from("one "));
    capture.push(Buffer.from("two"));
    expect(capture.text()).toBe("one two");
    expect(capture.truncated).toBe(false);
  });

  it("stops at its limit and says so", () => {
    const capture = createCapture(4);
    capture.push(Buffer.from("abc"));
    capture.push(Buffer.from("defg"));
    expect(capture.text()).toBe("abcd");
    expect(capture.truncated).toBe(true);
  });
});

describe("serveLogLines", () => {
  it("writes one summary line, with the token counts when the reply has them", () => {
    const lines = serveLogLines(
      entry({
        reply: {
          body: "{}",
          streamed: false,
          promptTokens: 312,
          completionTokens: 180,
          truncated: false,
        },
      }),
      { verbose: false, color: plainColor },
    );
    expect(lines).toEqual(["POST /v1/chat/completions  org/a  200  1.4s  312→180 tok"]);
  });

  it("leaves out the token counts and the model when there are none", () => {
    const lines = serveLogLines(entry({ model: null, durationMs: 412 }), {
      verbose: false,
      color: plainColor,
    });
    expect(lines).toEqual(["POST /v1/chat/completions  200  412ms"]);
  });

  it("adds both bodies when verbose, indenting every line of them", () => {
    const lines = serveLogLines(
      entry({
        request: '{\n  "model": "org/a"\n}',
        reply: { body: '{\n  "id": "x"\n}', streamed: false, truncated: false },
      }),
      { verbose: true, color: plainColor },
    );
    expect(lines).toEqual([
      "POST /v1/chat/completions  org/a  200  1.4s",
      "  → {",
      '      "model": "org/a"',
      "    }",
      "  ← {",
      '      "id": "x"',
      "    }",
    ]);
  });

  it("writes no reply block when there was no body to keep", () => {
    const lines = serveLogLines(
      entry({
        method: "GET",
        path: "/v1/models",
        model: null,
        reply: { body: "", streamed: false, truncated: false },
      }),
      { verbose: true, color: plainColor },
    );
    expect(lines).toEqual(["GET /v1/models  200  1.4s"]);
  });

  it("marks a reply it could not capture whole", () => {
    const lines = serveLogLines(
      entry({ reply: { body: "data: one", streamed: true, truncated: true } }),
      { verbose: true, color: plainColor },
    );
    expect(lines.slice(1)).toEqual(["  ← data: one", "    … (truncated)"]);
  });

  it("colors the status by its class and leaves the text alone", () => {
    const ok = serveLogLines(entry(), { verbose: false, color })[0];
    const missing = serveLogLines(entry({ status: 404 }), { verbose: false, color })[0];
    const broken = serveLogLines(entry({ status: 502 }), { verbose: false, color })[0];
    expect(ok).toContain(color.green("200"));
    expect(missing).toContain(color.yellow("404"));
    expect(broken).toContain(color.red("502"));
    // eslint-disable-next-line no-control-regex
    expect(ok.replace(/\x1b\[[0-9;]*m/g, "")).toBe("POST /v1/chat/completions  org/a  200  1.4s");
  });
});
