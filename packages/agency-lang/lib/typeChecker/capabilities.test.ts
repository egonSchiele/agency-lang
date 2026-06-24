import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// Errors from the raises / effect-set diagnostics only.
function capErrors(src: string) {
  return typecheckSource(src).filter((e) =>
    /raises effect|not an effect set/.test(e.message),
  );
}

const hasEffectError = (errs: { message: string }[], effect: string) =>
  errs.some((e) => e.message.includes(`raises effect '${effect}'`));

// A node that calls the real, globally-available `read` — a pure read, and
// the only real stdlib call these tests make — under a given raises clause.
function nodeUsingRead(setExpr: string, importName: string): string {
  return (
    `import { ${importName} } from "std::capabilities"\n` +
    `node main(): string raises ${setExpr} {\n` +
    `  read("f.txt") with approve\n` +
    `  return "ok"\n}`
  );
}

describe("std::capabilities — sets containing filesystem read permit a real read()", () => {
  // Validated against reality: the real `read` raises std::read, and these
  // sets must contain it. A broken/unresolved set would reject the call.
  it("FileRead permits read()", () => {
    expect(capErrors(nodeUsingRead("<FileRead>", "FileRead"))).toHaveLength(0);
  });

  it("FileSystem (composite of FileRead + FileWrite) permits read()", () => {
    expect(capErrors(nodeUsingRead("<FileSystem>", "FileSystem"))).toHaveLength(0);
  });
});

describe("std::capabilities — non-read sets reject read() and resolve to real members", () => {
  // For sets with no filesystem-read member, a real read() must be rejected.
  // Asserting the rejection message lists a REAL member proves the set
  // actually resolved to its declared contents — if it had silently failed
  // to resolve, the message would echo the bare alias name (e.g. `<FileWrite>`)
  // instead of the member effects.
  const cases: [set: string, member: string][] = [
    ["FileWrite", "std::write"],
    ["Shell", "std::bash"],
    ["Messaging", "std::sendEmail"],
    ["Auth", "std::authorize"],
  ];

  cases.forEach(([set, member]) => {
    it(`${set} rejects read() and resolves to include ${member}`, () => {
      const errs = capErrors(nodeUsingRead(`<${set}>`, set));
      const err = errs.find((e) => e.message.includes("raises effect 'std::read'"));
      expect(err, `${set} should reject std::read`).toBeDefined();
      // Proves the set resolved to its real contents, not a literal fallback.
      expect(err!.message).toContain(member);
    });
  });
});

describe("std::capabilities — read-capable non-filesystem sets permit their own read effect but exclude std::read", () => {
  // These sets contain a read/query effect of their own. We positively
  // confirm membership of that READ effect (synthetic raise of a read effect
  // — no write/delete calls) AND that filesystem read is still excluded.
  // Together this proves the set resolved correctly: it contains its member
  // and does not contain std::read.
  const cases: [set: string, readEffect: string][] = [
    ["Network", "std::http::fetch"],
    ["Calendar", "std::listEvents"],
    ["Secrets", "std::getSecret"],
    ["Memory", "std::memory::recall"],
  ];

  cases.forEach(([set, readEffect]) => {
    it(`${set} permits ${readEffect} but not std::read`, () => {
      const src =
        `import { ${set} } from "std::capabilities"\n` +
        `node main(): string raises <${set}> {\n` +
        `  raise ${readEffect}("m", {})\n` +
        `  read("f.txt") with approve\n` +
        `  return "ok"\n}`;
      const errs = capErrors(src);
      // member is allowed (no error for it) ...
      expect(hasEffectError(errs, readEffect)).toBe(false);
      // ... but std::read is not in the set, so it is rejected.
      expect(hasEffectError(errs, "std::read")).toBe(true);
    });
  });
});
