import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { chromium, type Browser } from "playwright-core";
import { bundleSmokeProgram } from "../../scripts/bundle-browser-smoke.mjs";

// Runs the compiled program in a real browser page, with a browserHost
// whose terminal records what the program prints and whose variables hold
// GREETING, passed through main's InvocationOptions. The bundle comes from
// scripts/bundle-browser-smoke.mjs, which fails first if it still needs Node.

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = readFileSync(bundleSmokeProgram().bundlePath, "utf8");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

describe("the browser bundle", () => {
  it("prints, reads a variable, sleeps, and is refused a file read", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent("<!doctype html><html><body></body></html>");
    // The bundle is an ES module. A blob URL loads it as one, through a
    // module script that puts its exports on `window` for the step after.
    const url = await page.evaluate(
      (source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
      bundle,
    );
    await page.addScriptTag({
      type: "module",
      content: `import * as program from ${JSON.stringify(url)}; window.program = program;`,
    });
    await page.waitForFunction(() => "program" in window);
    // The page builds the host from the bundle's own export, so the program
    // and the host share one runtime.
    const printed = await page.evaluate(async () => {
      const program = (window as unknown as { program: any }).program;
      const lines: string[] = [];
      const host = program.browserHost({
        variables: { GREETING: "hi from the page" },
        terminal: { print: (values: unknown[]) => lines.push(values.join(" ")) },
      });
      await program.main({ host });
      return lines;
    });
    expect(pageErrors).toEqual([]);
    expect(printed).toEqual([
      "hello from the browser",
      "GREETING is hi from the page",
      expect.stringMatching(/^read refused: .*fileRead/),
    ]);
  });
});
