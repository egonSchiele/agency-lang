import type { ChatRuntime, ModelOptions, ServeFlags, ServeKind } from "./localServe.js";

/** The `agency local serve` command line: which flags name a model, how
 *  the per-model options written after a model are grouped with it, and
 *  the one list of targets that `serveTargets` takes. */

/** One model to serve, and everything said about how to serve it. The
 *  command line and `serve()` in `agency-lang/local` each build a list of
 *  these, and `serveTargets` takes nothing else about a model.
 *
 *  model    the name, URI, or directory, as the caller wrote it
 *  kind     the kind a flag gave it. Absent: read it from the model
 *  runtime  the chat runtime a flag gave it. Absent: the kind's default
 *  flag     the flag that named it, for messages. Absent for a plain
 *           argument
 *  lazy     load it on its first request, and stop it when another lazy
 *           model needs the memory. Absent: load it at startup and keep
 *           it loaded */
export type ServeTarget = {
  model: string;
  kind?: ServeKind;
  runtime?: ChatRuntime;
  flag?: string;
  lazy?: boolean;
} & ModelOptions;

/** The per-model options and how each one is spelled. */
const MODEL_OPTION_FLAGS = ["--draft", "--draft-tokens"];

/** The flags that name a model rather than set an option, so the model
 *  after them is a target too.
 *
 *  kind  the kind the flag gives its model. Null: read it from the model */
export type NamingFlag = {
  flag: string;
  key: "embedding" | "speech" | "image" | "vlm" | "lazy";
  kind: ServeKind | null;
  runtime: ChatRuntime | null;
  lazy: boolean;
};
export const NAMING_FLAGS: NamingFlag[] = [
  { flag: "--embedding", key: "embedding", kind: "embedding", runtime: null, lazy: false },
  { flag: "--speech", key: "speech", kind: "speech", runtime: null, lazy: false },
  { flag: "--image", key: "image", kind: "image", runtime: null, lazy: false },
  { flag: "--vlm", key: "vlm", kind: "chat", runtime: "mlx-vlm", lazy: false },
  { flag: "--lazy", key: "lazy", kind: null, runtime: null, lazy: true },
];

/** The flags on a command line that take a value, by spelling: "required"
 *  when the next token is always the value, "optional" when it is the value
 *  only if it does not start with `-`. A flag not listed takes no value, as
 *  `--limit-answers` does. */
export type ValueFlags = Record<string, "required" | "optional">;

/** An option as commander declares it. Only the parts `valueFlagsOf` reads. */
type DeclaredOption = { long?: string; short?: string; required: boolean; optional: boolean };

/** A command as commander declares it, with the commands above it. */
type DeclaredCommand = { options: readonly DeclaredOption[]; parent: DeclaredCommand | null };

/** The flags that take a value on `command` and every command above it,
 *  since commander accepts an ancestor's flag after the subcommand too.
 *  Read from the declarations, so a new flag is known here the moment it
 *  is declared. */
export function valueFlagsOf(command: DeclaredCommand): ValueFlags {
  const out: ValueFlags = {};
  for (let at: DeclaredCommand | null = command; at !== null; at = at.parent) {
    for (const option of at.options) {
      const arity = option.required ? "required" : option.optional ? "optional" : undefined;
      if (arity === undefined) {
        continue;
      }
      for (const spelling of [option.long, option.short]) {
        if (spelling !== undefined) {
          out[spelling] = arity;
        }
      }
    }
  }
  return out;
}

/** One token of a command line read as a flag: its spelling, the value
 *  written into the token itself (`--draft=small`, `-p8080`), and how many
 *  tokens the flag and its value take up. */
type ReadFlag = { flag: string; value: string | undefined; width: number };

/** Splits a flag token into its spelling and the value written into it:
 *  `--draft=small` and `-p8080` carry one, `--draft` and `-p` do not. */
function splitFlag(token: string): { flag: string; inline: string | undefined } {
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    return equals === -1
      ? { flag: token, inline: undefined }
      : { flag: token.slice(0, equals), inline: token.slice(equals + 1) };
  }
  return { flag: token.slice(0, 2), inline: token.length > 2 ? token.slice(2) : undefined };
}

/** Reads the flag at `argv[index]`, taking its value from the token itself
 *  or from the next one as `valueFlags` says. */
function readFlag(argv: string[], index: number, valueFlags: ValueFlags): ReadFlag {
  const { flag, inline } = splitFlag(argv[index]);
  const arity = valueFlags[flag];
  if (inline !== undefined || arity === undefined) {
    return { flag, value: inline, width: 1 };
  }
  const next = argv[index + 1];
  if (arity === "optional" && (next === undefined || next.startsWith("-"))) {
    return { flag, value: undefined, width: 1 };
  }
  return { flag, value: next, width: 2 };
}

/** The tokens after `local serve` on the command line, or none when the
 *  command line is not `local serve`. Walks the operands the way commander
 *  does, stepping over flags and their values, so a flag whose value
 *  happens to be the word `serve` does not fool it. */
export function argvAfterServe(argv: string[], valueFlags: ValueFlags): string[] {
  const words = ["local", "serve"];
  let matched = 0;
  // argv[0] is node and argv[1] the script.
  let index = 2;
  while (index < argv.length && matched < words.length) {
    const token = argv[index];
    if (token.startsWith("-") && token.length > 1) {
      index += readFlag(argv, index, valueFlags).width;
      continue;
    }
    if (token !== words[matched]) {
      return [];
    }
    matched += 1;
    index += 1;
  }
  return matched === words.length ? argv.slice(index) : [];
}

/** Groups the arguments after `serve` into one entry per model, each with
 *  the per-model options that followed it. `agency local serve a --draft d
 *  b` drafts for `a` and not `b`. Any other flag belongs to the command as
 *  a whole and is left for the option parser; `valueFlags` says whether it
 *  takes the next token as its value, so `a --limit-answers b` is two
 *  models. A parser, so its order is its nature; it holds nothing but what
 *  it returns. */
export function groupServeArgv(argv: string[], valueFlags: ValueFlags): ServeTarget[] {
  const targets: ServeTarget[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("-") || token.length === 1) {
      targets.push({ model: token });
      index += 1;
      continue;
    }
    const { flag, value, width } = readFlag(argv, index, valueFlags);
    index += width;
    if (NAMING_FLAGS.some((row) => row.flag === flag)) {
      if (value !== undefined) {
        targets.push({ model: value });
      }
    } else if (MODEL_OPTION_FLAGS.includes(flag)) {
      setModelOption(targets[targets.length - 1], flag, value ?? "<value>");
    }
  }
  for (const target of targets) {
    if (target.draftTokens !== undefined && target.draft === undefined) {
      throw new Error(
        `--draft-tokens needs a --draft for ${target.model}: agency local serve ${target.model} --draft <model> --draft-tokens ${target.draftTokens}`,
      );
    }
  }
  return targets;
}

/** Sets one per-model option on the model it follows, refusing one written
 *  before any model or given twice for the same model. */
function setModelOption(target: ServeTarget | undefined, flag: string, value: string): void {
  if (target === undefined) {
    throw new Error(
      `${flag} goes after the chat model it is for: agency local serve <model> ${flag} ${value}`,
    );
  }
  const key = flag === "--draft" ? "draft" : "draftTokens";
  if (target[key] !== undefined) {
    throw new Error(
      `${target.model} has ${flag} twice. Write it once after the model: agency local serve ${target.model} ${flag} ${value}`,
    );
  }
  if (key === "draft") {
    target.draft = value;
  } else {
    target.draftTokens = Number(value);
  }
}

/** The per-model options from grouped targets, keyed by model, for
 *  `ServeFlags.options`. */
export function optionsByModel(targets: ServeTarget[]): Record<string, ModelOptions> {
  const out: Record<string, ModelOptions> = {};
  for (const target of targets) {
    const { model, ...options } = target;
    if (Object.keys(options).length > 0) {
      out[model] = options;
    }
  }
  return out;
}

/** What one chat server is started with, beyond its model and port. */
/** The targets a parsed command line names: each plain argument, then each
 *  model a naming flag listed, with that flag's kind and runtime and the
 *  options written after the model. The one reader of `flags.options` and
 *  of the per-flag lists. */
export function targetsFromFlags(values: string[], flags: ServeFlags): ServeTarget[] {
  const optionsOf = (model: string) => flags.options?.[model] ?? {};
  const plain = values.map((model) => ({ model, ...optionsOf(model) }));
  const flagged = NAMING_FLAGS.flatMap((row) =>
    (flags[row.key] ?? []).map((model) => {
      const target: ServeTarget = { model, flag: row.flag, ...optionsOf(model) };
      if (row.kind !== null) {
        target.kind = row.kind;
      }
      if (row.runtime !== null) {
        target.runtime = row.runtime;
      }
      if (row.lazy) {
        target.lazy = true;
      }
      return target;
    }),
  );
  return [...plain, ...flagged];
}
