import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Annotation } from "@/runDirectory/annotations.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { createEvalUploadClient, EVENTS_PER_REQUEST, EvalUploadError } from "./evalUploadClient.js";
import { statelogRequest, type StatelogFailure } from "./statelogRequest.js";

vi.mock("./statelogRequest.js", () => ({ statelogRequest: vi.fn() }));

const requestMock = vi.mocked(statelogRequest);
const API_KEY = "stlog-key";

function client() {
  return createEvalUploadClient("https://h", "proj", API_KEY);
}

function envelope(sequence: number): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "t1",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type: "tick", timestamp: "2026-08-23T00:00:00Z", sequence },
  };
}

function lastOptions() {
  const call = requestMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("statelogRequest was not called");
  }
  return call[0];
}

async function failureOf(promise: Promise<unknown>): Promise<EvalUploadError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(EvalUploadError);
  return outcome as EvalUploadError;
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("traceUploadState", () => {
  const states = [
    { kind: "missing" },
    { kind: "empty" },
    { kind: "live", eventCount: 3 },
    { kind: "bulk-prefix", eventCount: 7, nextSequence: 7 },
    { kind: "invalid", eventCount: 2, reason: "rows 0 and 1 share sequence 0" },
  ];

  it("GETs the trace's upload-state route with the id encoded, and returns every state variant", async () => {
    for (const state of states) {
      requestMock.mockResolvedValueOnce({ ok: true, value: state, status: 200 });
      await expect(client().traceUploadState("t/1")).resolves.toEqual(state);
      expect(lastOptions()).toEqual({
        method: "GET",
        url: "https://h/api/projects/proj/traces/t%2F1/upload-state",
        apiKey: API_KEY,
        body: undefined,
      });
    }
  });

  it("rejects a response that is not one of the states", async () => {
    requestMock.mockResolvedValueOnce({ ok: true, value: { kind: "bulk" }, status: 200 });
    const error = await failureOf(client().traceUploadState("t1"));
    expect(error.message).toMatch(/unexpected upload-state response/);
  });
});

describe("postEvents", () => {
  it("POSTs the bulk logs route with the trace id and each event's sequence", async () => {
    requestMock.mockResolvedValueOnce({ ok: true, value: { accepted: 2 }, status: 200 });
    await client().postEvents("t1", [
      { sequence: 5, envelope: envelope(5) },
      { sequence: 6, envelope: envelope(6) },
    ]);
    expect(lastOptions()).toEqual({
      method: "POST",
      url: "https://h/api/projects/proj/logs/bulk",
      apiKey: API_KEY,
      body: {
        traceId: "t1",
        events: [
          { sequence: 5, event: envelope(5) },
          { sequence: 6, event: envelope(6) },
        ],
      },
    });
  });

  it("an empty list is a valid request (it creates the trace)", async () => {
    requestMock.mockResolvedValueOnce({ ok: true, value: {}, status: 200 });
    await client().postEvents("t1", []);
    expect(lastOptions().body).toEqual({ traceId: "t1", events: [] });
  });

  it("refuses more than the per-request limit before any transport", async () => {
    const tooMany = Array.from({ length: EVENTS_PER_REQUEST + 1 }, (_, index) => ({
      sequence: index,
      envelope: envelope(index),
    }));
    const error = await failureOf(client().postEvents("t1", tooMany));
    expect(error.message).toMatch(/501 events.*limit is 500/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("postAnnotations", () => {
  it("POSTs the annotations route with the rows as given", async () => {
    const row = { v: 1, id: `ann_${"a".repeat(64)}`, traceId: "t1" } as Annotation;
    requestMock.mockResolvedValueOnce({ ok: true, value: {}, status: 200 });
    await client().postAnnotations([row]);
    expect(lastOptions()).toMatchObject({
      method: "POST",
      url: "https://h/api/projects/proj/annotations",
      body: { annotations: [row] },
    });
  });
});

describe("failure mapping", () => {
  const cases: [StatelogFailure, RegExp, number | undefined][] = [
    [
      { kind: "unreachable", cause: "ECONNREFUSED" },
      /could not reach https:\/\/h \(ECONNREFUSED\)/,
      undefined,
    ],
    [
      { kind: "http", status: 404, serverError: "Project not found" },
      /project 'proj' not found/,
      404,
    ],
    [{ kind: "http", status: 404 }, /does not support eval upload/, 404],
    [{ kind: "http", status: 500, serverError: "boom" }, /^boom$/, 500],
    [{ kind: "http", status: 502 }, /HTTP 502/, 502],
    [{ kind: "non-json", status: 200, diagnostic: "got HTML" }, /got HTML/, 200],
    [{ kind: "bad-envelope", status: 200 }, /unexpected eval upload response shape/, 200],
    [{ kind: "envelope-error", status: 200, serverError: "nope" }, /^nope$/, 200],
    [{ kind: "envelope-error", status: 200 }, /eval upload request failed/, 200],
  ];

  it("turns every transport failure into an EvalUploadError with a plain message", async () => {
    for (const [failure, message, status] of cases) {
      requestMock.mockResolvedValueOnce({ ok: false, failure });
      const error = await failureOf(client().postAnnotations([]));
      expect(error.message, failure.kind).toMatch(message);
      expect(error.status, failure.kind).toBe(status);
    }
  });
});
