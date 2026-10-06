import {
  serveTargets,
  loggedDeps,
  type ServeDeps,
  type ServeHandle,
  type ServeTarget,
} from "../cli/localServe.js";
import type { ModelKind } from "../stdlib/modelKind.js";

/** One model for `serve`, with how to serve it.
 *
 *  model        a name `listModels` returned, an alias, a URI, or a
 *               directory
 *  lazy         load it on its first request, and stop it when another
 *               lazy model needs the memory, as `--lazy` does
 *  kind         serve it as this kind, as the command's `--embedding`,
 *               `--speech`, and `--image` flags do. Needed only when the
 *               model's files do not say what it is
 *  vlm          serve a chat model with mlx-vlm, so it takes images, as
 *               the command's `--vlm` flag does
 *  draft        a smaller model of the same family that drafts tokens for
 *               this one, as `--draft` does
 *  draftTokens  how many tokens the draft guesses at a time */
export type ServedModel = {
  model: string;
  lazy?: boolean;
  kind?: ModelKind;
  vlm?: boolean;
  draft?: string;
  draftTokens?: number;
};

/** The settings of the server `serve` starts.
 *
 *  port    the port to listen on. Absent or 0: any free port
 *  python  the Python to run the model servers with. Absent: the one
 *          `agency local serve` would choose
 *  log     receives each line the command would print to the terminal,
 *          and each line the model processes write. Absent: discarded */
export type ServeOptions = {
  port?: number;
  python?: string;
  log?: (line: string) => void;
};

/** A running server. `url` is the base URL for the call functions and for
 *  any OpenAI client. */
export type LocalServer = ServeHandle;

/** The target for one served model. `vlm` is the `--vlm` flag: a chat
 *  model on the mlx-vlm runtime. */
function targetOf(served: string | ServedModel): ServeTarget {
  if (typeof served === "string") {
    return { model: served };
  }
  const target: ServeTarget = { model: served.model };
  if (served.lazy === true) {
    target.lazy = true;
  }
  if (served.vlm === true) {
    target.kind = "chat";
    target.runtime = "mlx-vlm";
    target.flag = "--vlm";
  } else if (served.kind !== undefined) {
    target.kind = served.kind;
  }
  if (served.draft !== undefined) {
    target.draft = served.draft;
  }
  if (served.draftTokens !== undefined) {
    target.draftTokens = served.draftTokens;
  }
  return target;
}

/** Start a local model server, as `agency local serve` does, and resolve
 *  once every model that is not lazy has loaded. A lazy model loads on its
 *  first request. Each model is a name or a `ServedModel`.
 *
 *  ```ts
 *  const server = await serve(["z-image-turbo", "wd14-tagger"]);
 *  const made = await generateImage({ baseUrl: server.url, model: "z-image-turbo", prompt });
 *  await server.close();
 *  ``` */
export function serve(
  models: (string | ServedModel)[],
  options: ServeOptions = {},
): Promise<LocalServer> {
  return serveWithDeps(models, options, loggedDeps(options.log ?? (() => {})));
}

/** `serve` with what the server touches outside itself replaced, for
 *  tests. Not exported from `agency-lang/local`. */
export async function serveWithDeps(
  models: (string | ServedModel)[],
  options: ServeOptions,
  deps: ServeDeps,
): Promise<LocalServer> {
  const settings = { port: options.port, python: options.python };
  return serveTargets(models.map(targetOf), settings, deps);
}
