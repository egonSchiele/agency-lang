import { describe, it, expect } from "vitest";
import {
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
    // The doc that motivated the boundary rule: "incl." must not truncate.
    expect(firstSentence(sets["Calendar"].doc)).toContain("authorization)");
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
