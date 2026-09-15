import { describe, it, expect } from "vitest";
import {
  oneLine,
  createCapture,
  describeReply,
  describeRequest,
  serveLogLines,
  type LogEntry,
  type Reply,
} from "./serveLog.js";
import { color, plainColor } from "../utils/termcolors.js";

function reply(over: Partial<Reply> = {}): Reply {
  return {
    status: 200,
    body: "",
    contentType: "application/json",
    truncated: false,
    totalBytes: 0,
    ...over,
  };
}

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
    const summary = describeReply(reply({ body }));
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
    const summary = describeReply(reply({ body, contentType: "text/event-stream" }));
    expect(summary.body).toBe(body);
    expect(summary.streamed).toBe(true);
    expect(summary.promptTokens).toBe(3);
    expect(summary.completionTokens).toBe(2);
  });

  it("keeps a body that is not JSON, with no counts", () => {
    const summary = describeReply(
      reply({ body: "Internal Server Error", contentType: "text/plain" }),
    );
    expect(summary.body).toBe("Internal Server Error");
    expect(summary.promptTokens).toBeUndefined();
  });

  it("carries the truncated flag through", () => {
    expect(
      describeReply(reply({ body: "half a re", contentType: "text/plain", truncated: true }))
        .truncated,
    ).toBe(true);
  });

  it("summarizes an audio reply by its byte count and keeps its bytes out of the log", () => {
    const summary = describeReply(
      reply({ body: "RIFFjunk", contentType: "audio/wav", totalBytes: 318764 }),
    );
    expect(summary).toEqual({ body: "", streamed: false, truncated: false, audioBytes: 318764 });
    const cut = describeReply(
      reply({
        body: "x",
        contentType: "application/octet-stream",
        truncated: true,
        totalBytes: 2_000_000,
      }),
    );
    expect(cut.audioBytes).toBe(2_000_000);
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

  it("counts every byte it was given, kept or not", () => {
    const capture = createCapture(4);
    capture.push(Buffer.from("abc"));
    capture.push(Buffer.from("defgh"));
    expect(capture.total).toBe(8);
    expect(capture.text()).toBe("abcd");
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

  it("says the reply was cut off even when no bytes of it were kept", () => {
    const lines = serveLogLines(entry({ reply: { body: "", streamed: true, truncated: true } }), {
      verbose: true,
      color: plainColor,
    });
    expect(lines.slice(1)).toEqual(["  ← … (truncated)"]);
  });

  it("prints the audio size in place of token counts, and no reply block when verbose", () => {
    const e = entry({
      path: "/v1/audio/speech",
      durationMs: 15400,
      request: '{"input": "hi"}',
      reply: { body: "", streamed: false, truncated: false, audioBytes: 318764 },
    });
    expect(serveLogLines(e, { verbose: false, color: plainColor })).toEqual([
      "POST /v1/audio/speech  org/a  200  15.4s  318,764 bytes of audio",
    ]);
    const verbose = serveLogLines(e, { verbose: true, color: plainColor });
    expect(verbose[0]).toBe("POST /v1/audio/speech  org/a  200  15.4s");
    expect(verbose.some((line) => line.includes("←"))).toBe(false);
    expect(verbose).toContain("  318,764 bytes of audio");
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

describe("oneLine", () => {
  it("escapes the control characters in a value that came from a request", () => {
    expect(oneLine("org/a\nPOST /fake 200")).toBe("org/a\\x0aPOST /fake 200");
    expect(oneLine("org/a\x1b[31mred")).toBe("org/a\\x1b[31mred");
    expect(oneLine("mlx-community/Qwen3.8-27B-4bit")).toBe("mlx-community/Qwen3.8-27B-4bit");
  });

  it("keeps a forged line out of the summary", () => {
    const line = serveLogLines(entry({ model: "org/a\nGET /forged  200" }), {
      verbose: false,
      color: plainColor,
    })[0];
    expect(line.includes("\n")).toBe(false);
  });
});
