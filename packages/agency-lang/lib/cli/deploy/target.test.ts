import { describe, it, expect } from "vitest";
import { resolveDeployTarget } from "./target.js";

describe("resolveDeployTarget", () => {
  it("reads host/project from agency.json log and the key from $STATELOG_API_KEY", () => {
    const result = resolveDeployTarget(
      { host: "https://statelog.example", projectId: "proj" },
      {},
      { STATELOG_API_KEY: "env-key" },
    );
    expect(result).toEqual({
      ok: true,
      target: { host: "https://statelog.example", projectId: "proj", apiKey: "env-key" },
      provenance: {
        host: "agency.json log.host",
        projectId: "agency.json log.projectId",
        apiKey: "$STATELOG_API_KEY",
      },
    });
  });

  it("lets flags override host and project", () => {
    const result = resolveDeployTarget(
      { host: "https://baked", projectId: "baked-proj" },
      { host: "https://flag", project: "flag-proj" },
      { STATELOG_API_KEY: "k" },
    );
    expect(result.ok && result.target.host).toBe("https://flag");
    expect(result.ok && result.target.projectId).toBe("flag-proj");
  });

  it("reads the key from the --api-key-env variable when given", () => {
    const result = resolveDeployTarget(
      { host: "https://h", projectId: "p" },
      { apiKeyEnv: "MY_KEY" },
      { MY_KEY: "custom-key", STATELOG_API_KEY: "default-key" },
    );
    expect(result.ok && result.target.apiKey).toBe("custom-key");
    expect(result.ok && result.provenance.apiKey).toBe("$MY_KEY");
  });

  it("never reads the key from agency.json (env only)", () => {
    const result = resolveDeployTarget({ host: "https://h", projectId: "p" }, {}, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("STATELOG_API_KEY");
  });

  it("errors when the host is missing", () => {
    const result = resolveDeployTarget({ projectId: "p" }, {}, { STATELOG_API_KEY: "k" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("host");
  });

  it("errors when the host is not a valid URL (no scheme)", () => {
    const result = resolveDeployTarget(
      { host: "statelog.example", projectId: "p" },
      {},
      { STATELOG_API_KEY: "k" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("valid host URL");
  });

  it("errors listing every missing field at once", () => {
    const result = resolveDeployTarget(undefined, {}, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("host");
    expect(result.error).toContain("project");
    expect(result.error).toContain("API key");
  });
});
