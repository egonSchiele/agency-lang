import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// Only the raises/effect-set diagnostics matter here.
function capErrors(src: string) {
  return typecheckSource(src).filter((e) =>
    /raises effect|not an effect set/.test(e.message),
  );
}

describe("std::capabilities effect sets", () => {
  it("FileSystem permits both reads and writes", () => {
    const errs = capErrors(
      'import { FileSystem } from "std::capabilities"\n' +
        "node main(): string raises <FileSystem> {\n" +
        '  raise std::read("m", {})\n' +
        '  raise std::write("m", {})\n' +
        '  return "ok"\n}',
    );
    expect(errs).toHaveLength(0);
  });

  it("FileRead does NOT permit a write (composed/precise sets work)", () => {
    const errs = typecheckSource(
      'import { FileRead } from "std::capabilities"\n' +
        "node main(): string raises <FileRead> {\n" +
        '  raise std::write("m", {})\n' +
        '  return "ok"\n}',
    );
    expect(errs.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("FileSystem (a composed set) spreads FileRead+FileWrite even when only FileSystem is imported", () => {
    // Regression guard: importing only the composite must still pull in the
    // member sets transitively *with* their effect-set flag, or std::write
    // would be misread as a non-effect-set reference.
    const errs = capErrors(
      'import { FileSystem } from "std::capabilities"\n' +
        "node main(): string raises <FileSystem> {\n" +
        '  raise std::edit("m", {})\n' +
        '  return "ok"\n}',
    );
    expect(errs).toHaveLength(0);
  });

  it("composing imported sets: <FileRead, Network> permits read + fetch", () => {
    const errs = capErrors(
      'import { FileRead, Network } from "std::capabilities"\n' +
        "node main(): string raises <FileRead, Network> {\n" +
        '  raise std::read("m", {})\n' +
        '  raise std::http::fetch("m", {})\n' +
        '  return "ok"\n}',
    );
    expect(errs).toHaveLength(0);
  });

  it("Messaging permits sendEmail but not a shell command", () => {
    const errs = typecheckSource(
      'import { Messaging } from "std::capabilities"\n' +
        "node main(): string raises <Messaging> {\n" +
        '  raise std::sendEmail("m", {})\n' +
        '  raise std::bash("m", {})\n' +
        '  return "ok"\n}',
    );
    expect(errs.find((e) => /raises effect 'std::bash'/.test(e.message))).toBeDefined();
    expect(errs.find((e) => /raises effect 'std::sendEmail'/.test(e.message))).toBeUndefined();
  });
});
