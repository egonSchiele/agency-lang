import { InvalidArgumentError } from "@/vendor/commander/index.js";
import type { ResolvedModelFlag } from "@/config.js";
import { levenshtein } from "@/levenshtein.js";
import { _listHostedModels } from "@/stdlib/llm.js";

/** Suggest a catalog name only when it is this close to what was typed. */
const SUGGESTION_DISTANCE = 3;

function hostedTextModelNames(): string[] {
  return _listHostedModels().map((model) => model.name);
}

/**
 * Turn a `--model` value into a model and, when the user said one, a provider.
 *
 * A slash means a provider was named: everything before the FIRST slash is the
 * provider, everything after is the model. Splitting on the first slash only is
 * what lets `openrouter/anthropic/claude-sonnet-4` work — OpenRouter model
 * identifiers contain a slash of their own.
 *
 * A bare name is validated against the hosted text catalog, because that is the
 * only case where agency has to work the provider out for itself. A prefixed
 * name is never validated: `client.providerModules` can register a provider
 * under any name at startup, so at flag-parse time a custom provider and a typo
 * look identical, and guessing would reject working setups.
 */
export function resolveModelFlag(
  value: string,
  catalogNames: string[] = hostedTextModelNames(),
): ResolvedModelFlag {
  if (value === "") {
    throw new InvalidArgumentError("No model named.");
  }

  const slash = value.indexOf("/");
  if (slash !== -1) {
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (provider === "" || model === "") {
      throw new InvalidArgumentError(
        `"${value}" is not a model. Write provider/model, e.g. openrouter/anthropic/claude-sonnet-4.`,
      );
    }
    return { model, explicitProvider: provider };
  }

  if (catalogNames.includes(value)) {
    return { model: value };
  }
  throw new InvalidArgumentError(unknownModelMessage(value, catalogNames));
}

function unknownModelMessage(value: string, catalogNames: string[]): string {
  const lines = [`Unknown model "${value}".`];
  const suggestion = closestName(value, catalogNames);
  if (suggestion !== undefined) {
    lines.push(`Did you mean "${suggestion}"?`);
  }
  lines.push(
    `For a model from another provider, write provider/model — e.g. openrouter/${value}.`,
    "Run `agency models list` to see the catalog.",
  );
  return lines.join("\n  ");
}

function closestName(value: string, catalogNames: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGESTION_DISTANCE + 1;
  for (const name of catalogNames) {
    const distance = levenshtein(value, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return bestDistance <= SUGGESTION_DISTANCE ? best : undefined;
}
