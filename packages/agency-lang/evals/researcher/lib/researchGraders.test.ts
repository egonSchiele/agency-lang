import * as http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CitationCheck, checkCitation, citationGrade, citedUrls } from "./researchGraders.js";

describe("citedUrls", () => {
  it("keeps a closing paren that the URL opened", () => {
    expect(citedUrls("see https://en.wikipedia.org/wiki/Amnesiac_(album) for more")).toEqual([
      "https://en.wikipedia.org/wiki/Amnesiac_(album)",
    ]);
  });

  it("drops a closing paren the sentence put after the URL", () => {
    expect(citedUrls("(interview at https://example.com/a).")).toEqual(["https://example.com/a"]);
    expect(citedUrls("[text](https://example.com/b)")).toEqual(["https://example.com/b"]);
  });

  it("stops at markdown emphasis, code spans, and brackets", () => {
    expect(
      citedUrls(
        "**https://example.com/a** and `https://example.com/b` and <https://example.com/c>",
      ),
    ).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  });

  it("trims sentence punctuation and keeps each URL once", () => {
    expect(
      citedUrls("https://example.com/a, https://example.com/a; https://example.com/b."),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

describe("checkCitation", () => {
  // Answers each path with the status the path names: /status/404 is a 404.
  const server = http.createServer((request, response) => {
    const status = Number(request.url?.split("/").pop());
    response.writeHead(status);
    response.end("body");
  });
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("calls a 200 ok", async () => {
    expect((await checkCitation(`${base}/status/200`)).verdict).toBe("ok");
  });

  it("calls a 404 or a 410 missing, since the page does not exist", async () => {
    expect((await checkCitation(`${base}/status/404`)).verdict).toBe("missing");
    expect((await checkCitation(`${base}/status/410`)).verdict).toBe("missing");
  });

  it("calls a 403, a 429, or a server error unchecked, since the page may be real", async () => {
    expect((await checkCitation(`${base}/status/403`)).verdict).toBe("unchecked");
    expect((await checkCitation(`${base}/status/429`)).verdict).toBe("unchecked");
    expect((await checkCitation(`${base}/status/503`)).verdict).toBe("unchecked");
  });
});

describe("citationGrade", () => {
  const ok: CitationCheck = { url: "https://example.com/ok", verdict: "ok", note: "HTTP 200" };
  const missing: CitationCheck = {
    url: "https://example.com/gone",
    verdict: "missing",
    note: "HTTP 404",
  };
  const unchecked: CitationCheck = {
    url: "https://example.com/blocked",
    verdict: "unchecked",
    note: "HTTP 403",
  };

  it("fails an answer that cites nothing", () => {
    expect(citationGrade([]).score).toEqual({ kind: "binary", pass: false });
  });

  it("charges a missing page its share and an unchecked page nothing", () => {
    const grade = citationGrade([ok, missing, unchecked, ok]);
    expect(grade.score).toEqual({ kind: "scalar", value: 0.75 });
    expect(grade.feedback).toContain("4 cited, 1 missing");
  });

  it("fails when nothing could be checked, so a machine whose fetches all fail passes nothing", () => {
    const grade = citationGrade([unchecked, unchecked]);
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toContain("none of the 2 cited URLs could be checked");
  });
});
