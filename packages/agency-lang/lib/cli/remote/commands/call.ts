import { reportUnhandledInterrupts } from "@/runtime/interrupts.js";
import { resolveInterrupts } from "@/runtime/interruptResolution.js";
import { readBinding } from "../binding.js";
import { buildArgs } from "../args.js";
import type { RemoteArgsOptions } from "../args.js";
import { resolveRemoteDecision } from "../decision.js";
import { createServeClient } from "../../statelog/serveClient.js";
import { renderResult } from "../render.js";
import { fail, apiKeyOrExit } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

export type RemoteCallOptions = RemoteArgsOptions & {
  function?: boolean;
  interactive?: boolean;
  policy?: string;
  approve?: string;
  reject?: string;
  apiKeyEnv?: string;
};

export async function runCall(
  name: string,
  options: RemoteCallOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const binding = readBinding(context.configPath);
  if (!binding) {
    fail(
      "Not linked. Run 'agency remote deploy <file>' first (or 'agency remote link --url <serveBase>').",
    );
  }
  const apiKey = apiKeyOrExit(options);
  try {
    const args = buildArgs(options);
    const decide = resolveRemoteDecision(options);
    const client = createServeClient(binding, apiKey);

    // Functions are one-shot — no resume path. A surfaced function interrupt
    // (or any failed AgencyResult) is recognized at the serve-client boundary
    // and thrown as a ServeRequestError, so it reaches the catch below and exits
    // non-zero rather than printing a failure object with a success status.
    if (options.function) {
      const value = await client.invokeFunction(name, args);
      console.log(renderResult(value));
      return;
    }

    const initialResult = await client.invokeNode(name, args);
    if (!decide) {
      // No interrupt flag: a surfaced interrupt is reported unhandled and exits,
      // exactly like `agency run` with no policy flag.
      reportUnhandledInterrupts(initialResult);
      console.log(renderResult(initialResult.data));
      return;
    }
    const result = await resolveInterrupts(initialResult, client.resume, decide);
    console.log(renderResult(result.data));
  } catch (error) {
    // One catch turns client, policy, and argument failures into the normal
    // clean CLI error path instead of an unhandled rejection.
    fail(error instanceof Error ? error.message : String(error));
  }
}
