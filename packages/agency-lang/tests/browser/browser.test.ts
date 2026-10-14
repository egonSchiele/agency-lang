import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { chromium, type Browser } from "playwright-core";
import { bundleSmokeProgram } from "../../scripts/bundle-browser-smoke.mjs";

// Runs the compiled programs in a real browser page, with a browserHost
// whose terminal records what the program prints and whose variables hold
// what the program asks for, passed through the node's InvocationOptions.
// The bundle comes from scripts/bundle-browser-smoke.mjs, which fails first
// if it still needs Node.
//
// The model case calls OpenAI for real, with the key from OPENAI_API_KEY,
// and is skipped without one. The Browser workflow passes the key.

let browser: Browser;
let bundle: string;
const openAiKey = process.env.OPENAI_API_KEY ?? "";
// The model the real call uses: a cheap one. The provider is named because
// agency.json bakes a different one into the program.
const model = "gpt-4.1-nano";
const provider = "openai";

beforeAll(async () => {
  bundle = readFileSync(bundleSmokeProgram().bundlePath, "utf8");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** A page with the bundle loaded as `window.program`, and the errors the
 *  page reports. The bundle is an ES module. A blob URL loads it as one,
 *  through a module script that puts its exports on `window`. */
async function pageWithProgram() {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent("<!doctype html><html><body></body></html>");
  const url = await page.evaluate(
    (source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
    bundle,
  );
  await page.addScriptTag({
    type: "module",
    content: `import * as program from ${JSON.stringify(url)}; window.program = program;`,
  });
  await page.waitForFunction(() => "program" in window);
  return { page, pageErrors };
}

describe("the browser bundle", () => {
  it("prints, reads a variable, sleeps, and is refused a file read", async () => {
    const { page, pageErrors } = await pageWithProgram();
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
      // Refused when `read` is entered, by its @capabilities tag, before
      // its body runs and before the `with approve` handler is asked.
      "read refused: read needs the fileRead capability, which the browser host does not have. Calling read again will fail the same way.",
    ]);
  });

  it.skipIf(openAiKey === "")("calls a hosted model with the key the page passed", async () => {
    const { page, pageErrors } = await pageWithProgram();
    // The key reaches smoltalk through the host's settings, read by the
    // runtime's client. Nothing in the page sets process.env.
    const reply = await page.evaluate(
      async ([key, model, provider]) => {
        const program = (window as unknown as { program: any }).program;
        const host = program.browserHost({ variables: { OPENAI_API_KEY: key } });
        const result = await program.ask(model, provider, { host });
        return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      },
      [openAiKey, model, provider],
    );
    expect(pageErrors).toEqual([]);
    expect(reply.trim().toLowerCase()).toContain("pong");
  });

  it("refuses the model call on a host without the llm capability", async () => {
    const { page, pageErrors } = await pageWithProgram();
    const message = await page.evaluate(
      async ([key, model, provider]) => {
        const program = (window as unknown as { program: any }).program;
        const host = program.browserHost({
          capabilities: ["network", "env", "terminal"],
          variables: { OPENAI_API_KEY: key },
        });
        // The node wrapper turns the refusal into a failure result.
        const result = await program.ask(model, provider, { host });
        return JSON.stringify(result.data);
      },
      [openAiKey, model, provider],
    );
    expect(pageErrors).toEqual([]);
    expect(message).toContain(
      "llm needs the llm capability, which the browser host does not have.",
    );
  });
});
