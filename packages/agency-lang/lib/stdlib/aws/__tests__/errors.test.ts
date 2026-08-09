import { describe, it, expect } from "vitest";
import { parseS3Error, s3ErrorToFailure } from "../errors.js";

describe("parseS3Error", () => {
  it("extracts Code and Message", () => {
    const xml =
      `<?xml version="1.0"?><Error><Code>NoSuchBucket</Code>` +
      `<Message>The specified bucket does not exist</Message></Error>`;
    expect(parseS3Error(xml)).toEqual({
      code: "NoSuchBucket",
      message: "The specified bucket does not exist",
    });
  });

  it("returns empty fields for a non-XML body", () => {
    expect(parseS3Error("<html>proxy error</html>")).toEqual({ code: "", message: "" });
  });
});

describe("s3ErrorToFailure", () => {
  it("carries status, the parsed code, and a human summary", () => {
    const xml = `<Error><Code>AccessDenied</Code><Message>nope</Message></Error>`;
    const failure = s3ErrorToFailure(403, "Forbidden", "https://b.s3.amazonaws.com/k", xml);
    expect(failure.error.status).toBe(403);
    expect(failure.error.code).toBe("AccessDenied");
    expect(failure.error.s3Message).toBe("nope");
    expect(failure.error.message).toContain("AccessDenied");
  });

  it("falls back to a body snippet when there is no code", () => {
    const failure = s3ErrorToFailure(500, "Server Error", "https://b.s3.amazonaws.com/k", "boom");
    expect(failure.error.code).toBe("");
    expect(failure.error.message).toContain("boom");
  });
});
