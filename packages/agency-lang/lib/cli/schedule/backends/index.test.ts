import { describe, it, expectTypeOf } from "vitest";
import type { BackendType } from "../registry.js";
import type { InstallableBackendType } from "./index.js";

describe("backend type split", () => {
  it("BackendType is the registry-stored set", () => {
    expectTypeOf<BackendType>().toEqualTypeOf<"launchd" | "systemd" | "crontab">();
  });
  it("InstallableBackendType includes 'github'", () => {
    expectTypeOf<InstallableBackendType>().toEqualTypeOf<
      "launchd" | "systemd" | "crontab" | "github"
    >();
  });
});
