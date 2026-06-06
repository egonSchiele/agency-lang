import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { analyzeInterrupts } from "./interrupts.js";

function withSingleFile(source: string, fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agency-int-"));
  const file = path.join(dir, "main.agency");
  writeFileSync(file, source);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("analyzeInterrupts", () => {
  it("reports a direct interrupt with the right handler identity", () => {
    withSingleFile(
      `
node main() {
  handle {
    interrupt std::read("hi")
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        const s = result.sites[0];
        expect(s.site.kind).toBe("std::read");
        expect(s.site.file).toBe(file);
        expect(s.site.line).toBe(4); // 1-indexed line of `interrupt std::read(...)`
        expect(s.handlers).toHaveLength(1);
        // `with approve` parses as a functionRef handler (approve is a
        // builtin), not an inline handler — inline syntax is
        // `} with (param) { …body… }`.
        expect(s.handlers[0]).toMatchObject({
          shape: "functionRef",
          functionName: "approve",
          file,
          line: 3, // 1-indexed line of the `handle {` block
        });
      },
    );
  });

  it("reports an empty handler list when the interrupt is bare", () => {
    withSingleFile(
      `
node main() {
  interrupt std::read("hi")
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        expect(result.sites[0].handlers).toHaveLength(0);
      },
    );
  });

  it("reports the unknown kind for the bare `interrupt(...)` form", () => {
    withSingleFile(
      `
node main() {
  interrupt("hi")
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        expect(result.sites[0].site.kind).toBe("unknown");
      },
    );
  });

  it("propagates handlers across a function call chain with correct identity", () => {
    withSingleFile(
      `
def helper() {
  interrupt std::read("hi")
}

node main() {
  handle {
    helper()
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        expect(result.sites[0].handlers).toEqual([
          { shape: "functionRef", functionName: "approve", file, line: 7 },
        ]);
      },
    );
  });

  it("dedupes handlers across diamond paths", () => {
    withSingleFile(
      `
def shared() {
  interrupt std::read("hi")
}

def a1() { shared() }
def a2() { shared() }
def a3() { shared() }

node main() {
  handle {
    a1()
    a2()
    a3()
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        // Single handler at main's handle block, NOT three copies.
        expect(result.sites[0].handlers).toHaveLength(1);
        expect(result.sites[0].handlers[0].line).toBe(11); // main's `handle {` 1-indexed
      },
    );
  });

  it("handles recursion without looping (fixed point converges)", () => {
    withSingleFile(
      `
def loop() {
  loop()
  interrupt std::read("hi")
}

node main() {
  handle {
    loop()
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        expect(result.sites[0].handlers).toHaveLength(1);
      },
    );
  });

  it("reports both inline and functionRef handler shapes with correct identity", () => {
    withSingleFile(
      `
def myHandler(e: any): any { return e }

def doWork() {
  interrupt std::read("hi")
}

node main() {
  handle {
    doWork()
  } with myHandler
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        const h = result.sites[0].handlers[0];
        expect(h).toMatchObject({
          shape: "functionRef",
          functionName: "myHandler",
          file,
          line: 9,
        });
      },
    );
  });

  it("propagates through llm() tool arguments", () => {
    withSingleFile(
      `
def deleteEmails() {
  interrupt std::write("delete?")
}

node main() {
  handle {
    let _: string = llm("do work", { tools: [deleteEmails] })
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        const site = result.sites.find((s) => s.site.kind === "std::write");
        expect(site).toBeDefined();
        expect(site!.handlers).toHaveLength(1);
        expect(site!.handlers[0].line).toBe(7);
      },
    );
  });

  it("collects all lexically nested handle blocks", () => {
    withSingleFile(
      `
node main() {
  handle {
    handle {
      interrupt std::read("hi")
    } with approve
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        const lines = result.sites[0].handlers.map((h) => h.line).sort();
        expect(lines).toEqual([3, 4]); // both `handle {` lines (1-indexed)
      },
    );
  });

  it("collects handle blocks nested across function boundaries", () => {
    // Outer handle is in main; inner handle is in foo. Both must appear.
    withSingleFile(
      `
def foo() {
  handle {
    interrupt std::read("hi")
  } with approve
}

node main() {
  handle {
    foo()
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        const lines = result.sites[0].handlers.map((h) => h.line).sort();
        expect(lines).toEqual([3, 9]); // foo's inner handle, main's outer handle
      },
    );
  });

  it("reports multiple distinct sites sorted by file then line", () => {
    withSingleFile(
      `
node main() {
  handle {
    interrupt std::write("b")
    interrupt std::read("a")
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(2);
        // Sites are sorted by line, so std::write (line 4) comes first.
        expect(result.sites.map((s) => s.site.line)).toEqual([4, 5]);
        expect(result.sites.map((s) => s.site.kind)).toEqual(["std::write", "std::read"]);
      },
    );
  });

  it("unions handler sets when a site is reachable from multiple entries with different handlers", () => {
    withSingleFile(
      `
def shared() {
  interrupt std::read("hi")
}

node entryA() {
  handle {
    shared()
  } with approve
}

node entryB() {
  handle {
    shared()
  } with approve
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        // Both handlers (one per entry) should be reported.
        const lines = result.sites[0].handlers.map((h) => h.line).sort((a, b) => a - b);
        expect(lines).toEqual([7, 13]);
      },
    );
  });

  it("reports interrupts from an orphan function (no incoming callers)", () => {
    // `foo` is not called from anywhere; it is therefore an entry itself.
    // Spec: every site reachable from any function in the unit is reported.
    withSingleFile(
      `
def foo() {
  interrupt std::read("hi")
}
`,
      (file) => {
        const result = analyzeInterrupts(file, {});
        expect(result.sites).toHaveLength(1);
        expect(result.sites[0].handlers).toHaveLength(0);
      },
    );
  });

  it("follows imports across multiple files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agency-int-"));
    try {
      const helperFile = path.join(dir, "helper.agency");
      writeFileSync(
        helperFile,
        `
def helper() {
  interrupt std::read("hi")
}
`,
      );
      const mainFile = path.join(dir, "main.agency");
      writeFileSync(
        mainFile,
        `
import { helper } from "./helper.agency"

node main() {
  handle {
    helper()
  } with approve
}
`,
      );
      const result = analyzeInterrupts(mainFile, {});
      expect(result.sites).toHaveLength(1);
      expect(result.sites[0].site.file).toBe(path.resolve(helperFile));
      expect(result.sites[0].handlers).toHaveLength(1);
      expect(result.sites[0].handlers[0].file).toBe(path.resolve(mainFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
