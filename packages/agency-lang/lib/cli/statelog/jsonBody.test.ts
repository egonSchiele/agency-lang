import { describe, it, expect, vi } from "vitest";
import { readJsonBody } from "./jsonBody.js";

function textResponse(status: number, text: string, url = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

const request = { method: "POST", url: "http://h/api/projects/p/upload" };

function failure(result: Awaited<ReturnType<typeof readJsonBody>>): string {
  if (result.ok) throw new Error("expected a non-JSON failure");
  return result.error;
}

describe("readJsonBody", () => {
  it("returns the parsed value for a JSON body", async () => {
    const result = await readJsonBody(textResponse(200, '{"success":true}'), request);
    expect(result).toEqual({ ok: true, value: { success: true } });
  });

  it("names the status, method, and requested URL in the failure", async () => {
    const error = failure(await readJsonBody(textResponse(200, "<!doctype html>"), request));
    expect(error).toContain("statelog returned a non-JSON response (HTTP 200)");
    expect(error).toContain("POST http://h/api/projects/p/upload");
  });

  it("shows how the body starts", async () => {
    const error = failure(
      await readJsonBody(textResponse(200, "<!doctype html><title>Sign in</title>"), request),
    );
    expect(error).toContain("<!doctype html><title>Sign in</title>");
  });

  it("collapses whitespace and truncates a long body", async () => {
    const long = `<html>\n  ${"x".repeat(400)}\n</html>`;
    const error = failure(await readJsonBody(textResponse(200, long), request));
    expect(error).toContain("<html> x");
    expect(error).toContain("…");
    expect(error).not.toContain("x".repeat(300));
  });

  it("says when the body was empty", async () => {
    const error = failure(await readJsonBody(textResponse(200, ""), request));
    expect(error).toContain("body was empty");
  });

  it("names the final URL and the http:// cause when the request was redirected", async () => {
    const error = failure(
      await readJsonBody(
        textResponse(200, "<!doctype html>", "https://h/signin?redirect=/api/projects/p/upload"),
        request,
      ),
    );
    expect(error).toContain("redirected to https://h/signin?redirect=/api/projects/p/upload");
    expect(error).toContain("http://");
    expect(error).toContain("https://");
  });

  it("prints no redirect line when the response URL matches the request", async () => {
    const error = failure(
      await readJsonBody(textResponse(500, "Internal Server Error", request.url), request),
    );
    expect(error).not.toContain("redirected");
  });

  it("prints no redirect line when the response URL is unavailable", async () => {
    const error = failure(await readJsonBody(textResponse(500, "oops"), request));
    expect(error).not.toContain("redirected");
  });

  it("reports an unreadable body instead of throwing", async () => {
    const response = {
      ok: true,
      status: 200,
      url: "",
      text: vi.fn().mockRejectedValue(new Error("socket closed")),
    } as unknown as Response;
    const error = failure(await readJsonBody(response, request));
    expect(error).toContain("statelog returned a non-JSON response (HTTP 200)");
    expect(error).toContain("socket closed");
  });
});

describe("readJsonBody diagnostic sanitizer", () => {
  const SENTINEL = "sk-live-EXTREMELY-SECRET";
  const sanitize = (raw: string) => raw.split(SENTINEL).join("[redacted]");
  const options = { sanitizeDiagnostic: sanitize };

  it("sanitizes a whitespace-containing sentinel before whitespace collapsing", async () => {
    // The sentinel spans a newline in the raw body; after the collapse it would
    // no longer exist as one string, so sanitization must run on the RAW text.
    const brokenSentinel = "sk-live\nEXTREMELY-SECRET";
    const sanitizeBroken = (raw: string) => raw.split(brokenSentinel).join("[redacted]");
    const error = failure(
      await readJsonBody(textResponse(200, `<html>${brokenSentinel}</html>`), request, {
        sanitizeDiagnostic: sanitizeBroken,
      }),
    );
    expect(error).toContain("[redacted]");
    expect(error).not.toContain("EXTREMELY-SECRET");
  });

  it("leaves no visible prefix of a sentinel spanning the snippet cutoff", async () => {
    const body = "x".repeat(190) + SENTINEL + "y".repeat(50);
    const error = failure(await readJsonBody(textResponse(200, body), request, options));
    expect(error).not.toContain("sk-live");
    expect(error).toContain("[redacted]");
  });

  it("sanitizes a body-read exception message", async () => {
    const response = {
      ok: true,
      status: 200,
      url: "",
      text: vi.fn().mockRejectedValue(new Error(`stream broke carrying ${SENTINEL}`)),
    } as unknown as Response;
    const error = failure(await readJsonBody(response, request, options));
    expect(error).toContain("[redacted]");
    expect(error).not.toContain(SENTINEL);
  });

  it("sanitizes a redirect URL before display", async () => {
    const error = failure(
      await readJsonBody(
        textResponse(200, "<html>", `https://h/signin?leak=${SENTINEL}`),
        request,
        options,
      ),
    );
    expect(error).toContain("redirected");
    expect(error).toContain("[redacted]");
    expect(error).not.toContain(SENTINEL);
  });

  it("parses valid JSON from the original text even when the sanitizer would change it", async () => {
    const body = JSON.stringify({ success: true, value: SENTINEL });
    const result = await readJsonBody(textResponse(200, body), request, options);
    expect(result).toEqual({ ok: true, value: { success: true, value: SENTINEL } });
  });
});
