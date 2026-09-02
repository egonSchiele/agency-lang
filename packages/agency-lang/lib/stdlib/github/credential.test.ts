import { describe, it, expect, afterEach } from "vitest";
import {
  resolveTokenFromSources,
  _resolveAndCache,
  _resetGithubCredentialCacheForTests,
  invalidateGithubCredentialCache,
  type CredentialSources,
} from "./credential.js";

function sources(overrides: Partial<CredentialSources>): CredentialSources {
  return {
    env: {},
    ghAuthToken: async () => null,
    keyringGet: async () => null,
    ...overrides,
  };
}

afterEach(() => {
  _resetGithubCredentialCacheForTests();
});

describe("resolveTokenFromSources precedence", () => {
  it("GITHUB_TOKEN beats gh auth token even when both are set", async () => {
    const s = sources({
      env: { GITHUB_TOKEN: "from-env" },
      ghAuthToken: async () => "from-gh",
    });
    expect(await resolveTokenFromSources(s)).toBe("from-env");
  });

  it("GH_TOKEN is used when GITHUB_TOKEN is absent", async () => {
    const s = sources({ env: { GH_TOKEN: "from-gh-token-var" } });
    expect(await resolveTokenFromSources(s)).toBe("from-gh-token-var");
  });

  it("gh auth token beats the keyring", async () => {
    const s = sources({
      ghAuthToken: async () => "from-gh",
      keyringGet: async () => "from-keyring",
    });
    expect(await resolveTokenFromSources(s)).toBe("from-gh");
  });

  it("falls through a failing gh to the keyring", async () => {
    const s = sources({
      ghAuthToken: async () => {
        throw new Error("gh not installed");
      },
      keyringGet: async () => "from-keyring",
    });
    expect(await resolveTokenFromSources(s)).toBe("from-keyring");
  });

  it("asks the keyring for github-token in the agency-lang service", async () => {
    const seen: string[] = [];
    const s = sources({
      keyringGet: async (key, service) => {
        seen.push(`${service}/${key}`);
        return "t";
      },
    });
    await resolveTokenFromSources(s);
    expect(seen).toEqual(["agency-lang/github-token"]);
  });

  it("treats a keyring that throws (no backend on this platform) as a miss", async () => {
    const s = sources({
      keyringGet: async () => {
        throw new Error("System keyring is not supported on win32. Set AGENCY_OAUTH_KEY.");
      },
    });
    await expect(resolveTokenFromSources(s)).rejects.toThrow(/No GitHub credential/);
    await expect(resolveTokenFromSources(s)).rejects.not.toThrow(/AGENCY_OAUTH_KEY/);
  });

  it("names all three remedies on a total miss", async () => {
    await expect(resolveTokenFromSources(sources({}))).rejects.toThrow(
      /gh auth login[\s\S]*GITHUB_TOKEN[\s\S]*setSecret/,
    );
  });
});

describe("_resolveAndCache (cache layer, injected sources)", () => {
  it("caches a success for the process and resolves only once", async () => {
    let calls = 0;
    const first = sources({
      ghAuthToken: async () => {
        calls += 1;
        return "first";
      },
    });
    expect(await _resolveAndCache(first)).toBe("first");
    // A second call with a DIFFERENT source still returns the cached value.
    const second = sources({ ghAuthToken: async () => "second" });
    expect(await _resolveAndCache(second)).toBe("first");
    expect(calls).toBe(1);
  });

  it("re-resolves after the cache is invalidated", async () => {
    expect(await _resolveAndCache(sources({ env: { GITHUB_TOKEN: "stale" } }))).toBe("stale");
    invalidateGithubCredentialCache();
    expect(await _resolveAndCache(sources({ env: { GITHUB_TOKEN: "fresh" } }))).toBe("fresh");
  });

  it("does not cache a miss", async () => {
    await expect(_resolveAndCache(sources({}))).rejects.toThrow(/No GitHub credential/);
    // Same process, credential appears (user ran setSecret): next call finds it.
    expect(await _resolveAndCache(sources({ env: { GITHUB_TOKEN: "now-set" } }))).toBe("now-set");
  });
});
