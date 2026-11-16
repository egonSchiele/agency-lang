import { describe, it, expect, vi } from "vitest";
import {
  effectsCmd,
  renderEffectsList,
  renderSetDetail,
  renderEffectLookup,
  renderPolicyDetail,
  renderUnknownName,
  firstSentence,
} from "./effects.js";
import { builtinEffectSets } from "@/runtime/effectSets.js";
import { BUILTIN_POLICIES } from "@/runtime/builtinPolicies.js";

const sets = builtinEffectSets();

describe("firstSentence", () => {
  it("cuts at the first sentence boundary", () => {
    expect(firstSentence("Read-only access: files. Also more words.")).toBe(
      "Read-only access: files.",
    );
  });

  it("collapses newlines inside the sentence", () => {
    expect(firstSentence("Read-only\nfilesystem access. Rest.")).toBe(
      "Read-only filesystem access.",
    );
  });

  it("returns a dot-less doc whole", () => {
    expect(firstSentence("No trailing dot")).toBe("No trailing dot");
  });

  it("does not cut at an abbreviation mid-sentence", () => {
    expect(firstSentence("Events (incl. calendar authorization).")).toBe(
      "Events (incl. calendar authorization).",
    );
  });

  it("renders the real Calendar doc whole", () => {
    expect(firstSentence(sets["Calendar"].doc)).toBe(sets["Calendar"].doc);
  });
});

describe("renderEffectsList", () => {
  const out = renderEffectsList(sets, BUILTIN_POLICIES);

  it("lists every set with its doc line", () => {
    expect(out).toContain("FileRead");
    expect(out).toContain("Read-only filesystem access");
    expect(out).toContain("Shell");
  });

  it("lists the built-in policies", () => {
    expect(out).toContain("Built-in policies:");
    expect(out).toContain("with-writes");
    expect(out).toContain("approve-all");
  });

  it("shows flag usage", () => {
    expect(out).toContain("--approve");
    expect(out).toContain("--policy");
  });
});

describe("renderSetDetail", () => {
  it("shows the full doc and one member per line", () => {
    const out = renderSetDetail(sets["FileRead"]);
    expect(out).toContain("Read-only filesystem access");
    expect(out).toContain("std::read");
    expect(out).toContain("std::grep");
  });

  it("shows the composition of a nested set before the flat list", () => {
    const out = renderSetDetail(sets["FileSystem"]);
    expect(out.indexOf("FileRead + FileWrite")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("FileRead + FileWrite")).toBeLessThan(out.indexOf("std::read"));
  });
});

describe("renderEffectLookup", () => {
  it("names every set containing the effect", () => {
    const out = renderEffectLookup("std::write", sets);
    expect(out).toContain("FileWrite");
    expect(out).toContain("FileSystem");
    expect(out).not.toContain("FileRead\n");
  });

  it("says when no set contains it", () => {
    const out = renderEffectLookup("myapp::exec", sets);
    expect(out).toContain("No built-in set");
  });
});

describe("renderPolicyDetail", () => {
  it("shows the description and the resolved policy JSON", () => {
    const out = renderPolicyDetail("with-writes", "recommended + writes.", {
      "std::write": [{ match: { dir: "/tmp/**" }, action: "approve" }],
    });
    expect(out).toContain("recommended + writes.");
    expect(out).toContain('"std::write"');
    expect(out).toContain("/tmp/**");
  });
});

describe("renderUnknownName", () => {
  it("names a near-miss", () => {
    const out = renderUnknownName("FileReed", sets, ["minimal", "recommended"]);
    expect(out).toContain("FileRead");
  });

  it("points at the listing when nothing is close", () => {
    const out = renderUnknownName("Zzz", sets, ["minimal"]);
    expect(out).toContain("agency effects");
  });
});

/** Run `effectsCmd` with stdout, stderr, and process.exit captured. */
function runEffectsCmd(name: string): { stdout: string; stderr: string; exitCode: unknown } {
  let stdout = "";
  let stderr = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const error = vi.spyOn(console, "error").mockImplementation((message) => {
    stderr += String(message);
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  try {
    effectsCmd(name);
    return { stdout, stderr, exitCode: exit.mock.calls[0]?.[0] };
  } finally {
    write.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
}

describe("effectsCmd", () => {
  it("describes one set with its members", () => {
    const { stdout, exitCode } = runEffectsCmd("FileRead");
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("std::read");
    expect(stdout).toContain("std::grep");
  });

  it("shows a nested set's composition", () => {
    const { stdout } = runEffectsCmd("FileSystem");
    expect(stdout).toContain("FileSystem = FileRead + FileWrite");
  });

  it("reverse-looks-up an effect name", () => {
    const { stdout, exitCode } = runEffectsCmd("std::write");
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("FileWrite");
    expect(stdout).toContain("FileSystem");
  });

  it("prints a built-in policy resolved against the cwd", () => {
    const { stdout, exitCode } = runEffectsCmd("with-writes");
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('"std::write"');
    expect(stdout).toContain('"action": "approve"');
  });

  it("errors on an unknown name with a near-miss hint", () => {
    const { stderr, exitCode } = runEffectsCmd("FileReed");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FileRead");
  });
});
