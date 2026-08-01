import { describe, it, expect } from "vitest";
import { resolveDeployTarget } from "./target.js";

describe("resolveDeployTarget", () => {
  it("reads host/project/apiKey from agency.json log by default", () => {
    const result = resolveDeployTarget(
      { host: "https://statelog.example", projectId: "proj", apiKey: "key-in-config" },
      {},
      {},
    );
    expect(result).toEqual({
      ok: true,
      target: { host: "https://statelog.example", projectId: "proj", apiKey: "key-in-config" },
      provenance: {
        host: "agency.json log.host",
        projectId: "agency.json log.projectId",
        apiKey: "agency.json log.apiKey",
      },
    });
  });

  it("lets flags override host and project", () => {
    const result = resolveDeployTarget(
      { host: "https://baked", projectId: "baked-proj", apiKey: "k" },
      { host: "https://flag", project: "flag-proj" },
      {},
    );
    expect(result.ok && result.target.host).toBe("https://flag");
    expect(result.ok && result.target.projectId).toBe("flag-proj");
  });

  it("reads the api key env-first when --api-key-env is given, over log.apiKey", () => {
    const result = resolveDeployTarget(
      { projectId: "p", apiKey: "config-key" },
      { apiKeyEnv: "MY_KEY" },
      { MY_KEY: "env-key" },
    );
    expect(result.ok && result.target.apiKey).toBe("env-key");
    expect(result.ok && result.provenance.apiKey).toBe("$MY_KEY");
  });

  it("falls back to $STATELOG_API_KEY when neither flag nor log.apiKey is set", () => {
    const result = resolveDeployTarget(
      { projectId: "p" },
      {},
      { STATELOG_API_KEY: "default-key" },
    );
    expect(result.ok && result.target.apiKey).toBe("default-key");
  });

  it("defaults the host to localhost:1065 when unset", () => {
    const result = resolveDeployTarget({ projectId: "p", apiKey: "k" }, {}, {});
    expect(result.ok && result.target.host).toBe("http://localhost:1065");
  });

  it("errors listing what's missing when project and key are absent", () => {
    const result = resolveDeployTarget(undefined, {}, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("project");
    expect(result.error).toContain("API key");
  });
});
