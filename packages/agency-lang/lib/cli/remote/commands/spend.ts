// `agency remote spend [project]` — print hosted spend for one project, or the
// whole account when no project is given. Read-only. The command only selects
// scope and orchestrates: the window is resolved (and validated) by
// resolveSpendWindow, the figures come from the sealed clients, and formatting
// lives in render.

import { createAccountClient } from "../../statelog/accountClient.js";
import { createProjectClient } from "../../statelog/projectClient.js";
import { renderAccountSpend, renderProjectSpend } from "../render.js";
import {
  resolveSpendWindow,
  type ResolvedSpendWindow,
  type SpendWindowOptions,
} from "./spendWindow.js";
import {
  resolveAccountTarget,
  resolveProjectTarget,
  failAccount,
  failProjectCommand,
  fail,
  printJson,
} from "./util.js";
import type { AccountCommandOptions, RemoteCommandContext } from "./util.js";

export type SpendOptions = AccountCommandOptions &
  SpendWindowOptions & {
    json?: boolean;
    byModel?: boolean;
    byKind?: boolean;
  };

export async function runSpend(
  project: string | undefined,
  options: SpendOptions,
  context: RemoteCommandContext,
): Promise<void> {
  let window: ResolvedSpendWindow;
  try {
    window = resolveSpendWindow(options); // captures `now` once; throws on invalid flags / bad duration
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (project === undefined) {
    const target = resolveAccountTarget(context, options);
    try {
      const rows = await createAccountClient(target.origin, target.apiKey).getAccountSpend(window);
      if (options.json) {
        printJson(rows);
      } else {
        console.log(renderAccountSpend(rows, window.description));
      }
    } catch (error) {
      failAccount(error, target.apiKeyEnvName);
    }
    return;
  }

  const target = resolveProjectTarget(context, { ...options, project });
  try {
    const spend = await createProjectClient(
      target.origin,
      target.projectSlug,
      target.apiKey,
    ).getSpend(window);
    if (options.json) {
      printJson(spend);
    } else {
      console.log(
        renderProjectSpend(target.projectSlug, spend, window.description, {
          byModel: options.byModel ?? false,
          byKind: options.byKind ?? false,
        }),
      );
    }
  } catch (error) {
    failProjectCommand(error);
  }
}
