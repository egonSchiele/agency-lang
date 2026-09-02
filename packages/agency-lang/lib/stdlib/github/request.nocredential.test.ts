import { it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { withCtx } from "./testUtils.js";
import { _githubRequest, type GithubEndpoint } from "./request.js";

// Replace the whole credential module: resolution always fails here, so this
// file proves the ordering — no credential, no fetch — deterministically,
// even on a machine whose ambient gh login or keyring holds a real token.
// (Driving the real chain from this test would resolve that real token, and
// vitest would print it into the failure diff.)
vi.mock("./credential.js", () => ({
  resolveGithubToken: async () => {
    throw new Error("No GitHub credential (mocked)");
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const pingEndpoint: GithubEndpoint<{ n: number }, unknown> = {
  name: "GET /repos/o/r/pulls/{n}",
  method: "GET",
  path: (params) => `/repos/o/r/pulls/${params.n}`,
  response: z.unknown(),
};

it("does not fetch when no credential resolves", async () => {
  // The rejecting mock turns any unexpected pass-through into a loud test
  // failure instead of a real, authenticated network request.
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("fetch reached the network"));
  await expect(withCtx(() => _githubRequest(pingEndpoint, { n: 1 }))).rejects.toThrow(
    /No GitHub credential/,
  );
  expect(spy).not.toHaveBeenCalled();
});
