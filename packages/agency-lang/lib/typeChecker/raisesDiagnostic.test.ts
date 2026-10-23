import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { typecheckSource, raisesErrors } from "./testUtils.js";
import { typeCheckSource } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

describe("raises subset diagnostic", () => {
  it("passes when inferred ⊆ declared", () => {
    const errs = raisesErrors(
      'def f(): number raises <std::read> { raise std::read("m", {})\n return 1 }',
    );
    expect(errs).toHaveLength(0);
  });

  it("produces NO raises error for a fully valid program (false-positive guard)", () => {
    const errs = raisesErrors(
      "effectSet Fs = <std::read, std::write>\n" +
        'def f(): number raises Fs { raise std::read("m",{})\n raise std::write("m",{})\n return 1 }',
    );
    expect(errs).toHaveLength(0);
  });

  it("errors when a raised effect exceeds the declared set", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> { raise std::write("m", {})\n return 1 }',
    );
    const raisesErr = errs.find((e) => /raises effect/.test(e.message));
    expect(raisesErr).toBeDefined();
    expect(raisesErr!.message).toContain("std::write");
    expect(raisesErr!.message).toContain("raises <std::read>");
    expect(raisesErr!.message).not.toMatch(/handle it/i);
  });

  it("flags a locally-handled effect (decision A)", () => {
    const errs = typecheckSource(
      "def f(): number raises <std::read> {\n" +
        '  handle { raise std::write("m", {}) } with approve\n' +
        "  return 1\n}",
    );
    expect(errs.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("reports EACH offending effect", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> { raise std::write("m",{})\n raise std::shell("m",{})\n return 1 }',
    );
    const msgs = errs.filter((e) => /raises effect/.test(e.message)).map((e) => e.message);
    expect(msgs.some((m) => m.includes("std::write"))).toBe(true);
    expect(msgs.some((m) => m.includes("std::shell"))).toBe(true);
  });

  it("counts an effect raised transitively through a callee", () => {
    const errs = typecheckSource(
      'def inner() { raise std::write("m", {}) }\n' +
        "def f(): number raises <std::read> { inner()\n return 1 }",
    );
    expect(errs.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("checks NODE definitions too", () => {
    const errs = typecheckSource('node main() raises <std::read> { raise std::write("m", {}) }');
    expect(errs.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("raises <> rejects any inferred effect", () => {
    const errs = typecheckSource(
      'def f(): number raises <> { raise std::read("m",{})\n return 1 }',
    );
    expect(errs.find((e) => /raises effect/.test(e.message))).toBeDefined();
  });

  it("raises <*> imposes no upper bound", () => {
    expect(
      raisesErrors('def f(): number raises <*> { raise std::write("m",{})\n return 1 }'),
    ).toHaveLength(0);
  });

  it("omitted clause imposes no upper bound", () => {
    expect(raisesErrors('def f(): number { raise std::write("m",{})\n return 1 }')).toHaveLength(0);
  });
});

describe("unknown (unlabeled) effects", () => {
  it("`raise interrupt(...)` is reported as effect 'unknown', not 'interrupt'", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> { raise interrupt("x")\n return 1 }',
    );
    const err = errs.find((e) => /raises effect/.test(e.message));
    expect(err).toBeDefined();
    expect(err!.message).toContain("'unknown'");
    expect(err!.message).not.toContain("'interrupt'");
  });

  it("`raises <unknown>` precisely accepts an unlabeled interrupt", () => {
    const errs = raisesErrors(
      'def f(): number raises <unknown> { raise interrupt("x")\n return 1 }',
    );
    expect(errs).toHaveLength(0);
  });

  it("`raises <unknown>` does NOT accept a labeled effect", () => {
    const errs = typecheckSource(
      'def f(): number raises <unknown> { raise std::write("m",{})\n return 1 }',
    );
    expect(errs.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("`raises <*>` accepts an unlabeled interrupt too", () => {
    expect(
      raisesErrors('def f(): number raises <*> { raise interrupt("x")\n return 1 }'),
    ).toHaveLength(0);
  });
});

describe("raises must reference an effect set (not a plain type)", () => {
  it("errors when raises references a non-effectSet type alias", () => {
    const errs = typecheckSource(
      'type Color = "red" | "blue"\n' + "def f(): number raises Color { return 1 }",
    );
    expect(errs.find((e) => /not an effect set/.test(e.message))).toBeDefined();
  });

  it("treats an unknown bare name as a single literal effect (NOT an error)", () => {
    const errs = typecheckSource(
      'def f(): number raises deploy { raise deploy("m",{})\n return 1 }',
    );
    expect(errs.filter((e) => /not an effect set|raises effect/.test(e.message))).toHaveLength(0);
  });

  it("a bare-effect raises clause still enforces its bound", () => {
    const errs = typecheckSource('def f(): number raises deploy { raise ship("m",{})\n return 1 }');
    expect(errs.find((e) => /raises effect 'ship'/.test(e.message))).toBeDefined();
  });

  it("accepts a real effectSet reference", () => {
    const errs = typecheckSource(
      "effectSet FsKinds = <std::read>\n" +
        'def f(): number raises FsKinds { raise std::read("m", {})\n return 1 }',
    );
    expect(errs.filter((e) => /not an effect set|raises effect/.test(e.message))).toHaveLength(0);
  });

  describe("decorators", () => {
    const BUDGETED =
      "def budgeted(block: () -> any): Result<string> {\n" +
      "  return guard(cost: 1.00) {\n    return block()\n  }\n}\n";

    it("counts the decorator's effects against the clause, and names the decorator", () => {
      const errs = typecheckSource(
        BUDGETED + '@budgeted\ndef f(): Result<string> raises <std::read> {\n  return "x"\n}\n',
      );
      const raisesErr = errs.find((e) => /raises effect 'std::guard'/.test(e.message));
      expect(raisesErr).toBeDefined();
      expect(raisesErr!.name).toBe("raisesExceededViaDecorator");
      expect(raisesErr!.message).toContain("It is raised by decorator 'budgeted'.");
    });

    it("gives the plain message when the body raises the effect and the decorator does not", () => {
      const errs = typecheckSource(
        "def logged(block: () -> any): any {\n  return block()\n}\n" +
          "@logged\ndef f(): number raises <std::read> {\n" +
          '  raise std::write("m", {})\n  return 1\n}\n',
      );
      const raisesErr = errs.find((e) => /raises effect 'std::write'/.test(e.message));
      expect(raisesErr?.name).toBe("raisesExceeded");
    });

    it("names the decorator when the body and the decorator both raise the effect", () => {
      const errs = typecheckSource(
        BUDGETED +
          "@budgeted\ndef f(): Result<string> raises <std::read> {\n" +
          '  return guard(cost: 2.00) {\n    return "x"\n  }\n}\n',
      );
      const raisesErr = errs.find((e) => /raises effect 'std::guard'/.test(e.message));
      expect(raisesErr?.name).toBe("raisesExceededViaDecorator");
    });

    it("names an imported decorator, which the effect table keys by its local name", () => {
      const dir = makeAgencyTempDir("raises-decorator");
      try {
        fs.writeFileSync(path.join(dir, "budget.agency"), "export " + BUDGETED, "utf-8");
        const main = path.join(dir, "main.agency");
        const source =
          'import { budgeted as spend } from "./budget.agency"\n' +
          '@spend\ndef f(): Result<string> raises <std::read> {\n  return "x"\n}\n';
        fs.writeFileSync(main, source, "utf-8");
        const { errors } = typeCheckSource(source, main);
        const raisesErr = errors.find((e) => /raises effect 'std::guard'/.test(e.message));
        // The report carries codes, not entry names; AG3030 is the via form.
        expect(raisesErr?.code).toBe("AG3030");
        expect(raisesErr?.message).toContain("decorator 'spend'");
      } finally {
        safeDeleteDirectory(dir, false);
      }
    });

    it("is satisfied when the clause lists the decorator's effect", () => {
      const errs = raisesErrors(
        BUDGETED + '@budgeted\ndef f(): Result<string> raises <std::guard> {\n  return "x"\n}\n',
      );
      expect(errs).toHaveLength(0);
    });
  });
});
