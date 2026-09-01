// Test-only helpers shared by every lib/stdlib/github/*.test.ts file.
import { vi } from "vitest";
import { RuntimeContext } from "../../runtime/state/context.js";
import { ThreadStore } from "../../runtime/state/threadStore.js";
import { runInTestContext } from "../../runtime/asyncContext.js";

export function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

export async function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = makeCtx();
  const execCtx = await ctx.createExecutionContext({ runId: "github-test" });
  return runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), fn);
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function stubToken(): void {
  vi.stubEnv("GITHUB_TOKEN", "test-token-value");
}
