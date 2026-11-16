import { describe, expect, it } from "vitest";
import { capOutput, type CappedStream } from "./outputCap.js";

/** A stream that records what reaches it. */
function fake(): { stream: CappedStream; text: () => string } {
  const chunks: string[] = [];
  const stream: CappedStream = {
    write: (chunk: unknown, callback?: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      if (typeof callback === "function") callback();
      return true;
    },
  };
  return { stream, text: () => chunks.join("") };
}

const NOTICE = "\n[agency] output limit of 10 bytes reached; nothing more is saved\n";

describe("capOutput", () => {
  it("passes a write under the limit through", () => {
    const out = fake();
    capOutput(10, [out.stream]);
    out.stream.write("hello");
    out.stream.write("12345");
    expect(out.text()).toBe("hello12345");
  });

  it("cuts the write that crosses the limit, says so once, and drops what follows", () => {
    const out = fake();
    capOutput(10, [out.stream]);
    out.stream.write("hello ");
    out.stream.write("world, and more");
    out.stream.write("dropped");
    out.stream.write("dropped again");
    expect(out.text()).toBe(`hello worl${NOTICE}`);
  });

  it("counts bytes, and cuts a buffer the same way", () => {
    const out = fake();
    capOutput(10, [out.stream]);
    out.stream.write(Buffer.from("0123456789abc"));
    expect(out.text()).toBe(`0123456789${NOTICE}`);
  });

  it("names a limit of whole mebibytes in MiB", () => {
    const out = fake();
    capOutput(1024 * 1024, [out.stream]);
    out.stream.write("x".repeat(1024 * 1024 + 1));
    expect(out.text()).toContain("output limit of 1 MiB reached");
  });

  it("limits each stream on its own", () => {
    const out = fake();
    const err = fake();
    capOutput(10, [out.stream, err.stream]);
    out.stream.write("0123456789abc");
    err.stream.write("fine");
    expect(err.text()).toBe("fine");
  });

  it("still calls a write's callback once the stream is full", () => {
    const out = fake();
    capOutput(2, [out.stream]);
    let called = 0;
    out.stream.write("abc", () => called++);
    out.stream.write("def", () => called++);
    expect(called).toBe(2);
  });
});
