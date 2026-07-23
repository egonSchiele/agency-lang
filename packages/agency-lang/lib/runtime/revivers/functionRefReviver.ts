import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";
import type { FuncParam, ToolDefinition } from "../agencyFunction.js";
import { isBlockName, isLiftedCallbackName } from "../blockNames.js";
import { agencyStore } from "../asyncContext.js";

type FunctionRefRegistry = Record<string, AgencyFunction>;

export class FunctionRefReviver implements BaseReviver<AgencyFunction> {
  registry: FunctionRefRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is AgencyFunction {
    return AgencyFunction.isAgencyFunction(value);
  }

  serialize(value: AgencyFunction): Record<string, unknown> {
    const result: Record<string, unknown> = {
      __nativeType: this.nativeTypeName(),
      name: value.name,
      module: value.module,
    };
    // A renamed function is not in the registry under its new name, so the
    // ref must carry the name its registered ancestor was created under —
    // revive() looks that up and re-applies the rename.
    if (value.originalName !== value.name) {
      result.originalName = value.originalName;
    }
    // Serialize params with bound values inline
    if (value.params.some(p => p.isBound)) {
      result.params = value.params;
    }
    // Serialize full tool definition (may have reduced schema/description)
    if (value.toolDefinition) {
      result.toolDescription = value.toolDefinition.description;
    }
    if (value.isPreapproved) {
      result.isPreapproved = true;
    }
    return result;
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): AgencyFunction {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;
    const lookupName =
      typeof value.originalName === "string" ? value.originalName : name;

    const found = lookupInRegistry(this.registry, lookupName, module);
    if (!found) {
      return this.reviveMiss(name, module, value);
    }
    // Re-apply the rename so the revived function keeps the name tool-call
    // dispatch and the LLM saw when the state was serialized.
    const original = name === lookupName ? found : found.rename(name);

    let result: AgencyFunction;

    // If serialized params have bound values, reconstruct the bound function
    if (Array.isArray(value.params) && value.params.some((p: any) => p.isBound)) {
      const params = value.params as FuncParam[];
      // Rebuild bindings from the serialized params
      const bindings: Record<string, unknown> = {};
      for (const p of params) {
        if (p.isBound) {
          bindings[p.name] = p.boundValue;
        }
      }
      result = original.partial(bindings);

      // Restore tool description if it was customized via .describe(). Use
      // `.describe()` instead of `.withToolDefinition()` because the bound
      // result may have `toolDefinition === null` (when the original had
      // no tool def), and `.describe()` synthesizes a stub tool def in
      // that case so the description isn't silently dropped.
      if (typeof value.toolDescription === "string"
          && value.toolDescription !== result.toolDefinition?.description) {
        result = result.describe(value.toolDescription);
      }
    } else if (typeof value.toolDescription === "string"
        && value.toolDescription !== original.toolDefinition?.description) {
      // Restore tool description for non-bound functions that used .describe().
      // Covers the case where `original.toolDefinition` is null too (a function
      // that gained its tool def solely through `.describe()`).
      result = original.describe(value.toolDescription);
    } else {
      result = original;
    }

    // Restore preapproved state
    if (value.isPreapproved) {
      result = result.preapprove();
    }

    return result;
  }

  /** A registry miss must never throw here: revive() also runs during
   *  SERIALIZATION (`deepClone` inside `State.toJSON` round-trips through
   *  `JSON.parse` with revivers), so an eager throw crashes checkpoint
   *  writes — including the guard-trip checkpoint that salvages drafts
   *  (#652). Every miss maps to a stub that survives re-serialization and
   *  fails, precisely, only if something actually invokes it. */
  private reviveMiss(
    name: string,
    module: string,
    value: Record<string, unknown>,
  ): AgencyFunction {
    // Compiler-generated blocks register themselves only when their creating
    // line executes. A fresh process restoring a checkpoint has executed
    // nothing yet, so a miss here is EXPECTED for blocks — replay rebinds
    // block args at function entry before anything can call them (#513).
    if (isBlockName(name)) {
      return makeBlockStub(name, module);
    }
    // Lifted callback bodies (`__cb_<scope>_<n>`) can miss legitimately:
    // a parent process deserializes state that embeds a CHILD's checkpoint
    // (subprocess resume payload), and the parent never imports the child's
    // module. Unlike blocks, nothing rebinds a scoped-callback registration
    // on replay, so the revived entry may legitimately fire later — hence a
    // lazy resolve-at-invoke ref, not a tripwire. See blockNames.ts for the
    // side-by-side contrast.
    if (isLiftedCallbackName(name)) {
      return makeLazyCallbackRef(name, module, this);
    }
    // Anything else: an ordinary function whose module this process never
    // loaded — the same embedded-child-checkpoint shape as callbacks, but
    // nothing spontaneously fires these, so a tripwire is honest. The stub
    // is built from the serialized fields so serialize(revive(x)) === x and
    // the ref rides through this process undamaged.
    return makeUnresolvedFunctionStub(name, module, value);
  }
}

/** The one registry lookup, shared by revive-time resolution and the lazy
 *  callback ref's fire-time resolution so the two can never diverge. Fast
 *  path is the composite `${module}:${name}` key; the linear scan covers
 *  two legacy cases — older `.js` output that keyed by bare name, and any
 *  future keying scheme collisions. Either way the function identity check
 *  is authoritative. */
function lookupInRegistry(
  registry: FunctionRefRegistry,
  name: string,
  module: string,
): AgencyFunction | undefined {
  const direct = registry[`${module}:${name}`];
  if (direct && direct.name === name && direct.module === module) {
    return direct;
  }
  for (const entry of Object.values(registry)) {
    if (entry.name === name && entry.module === module) {
      return entry;
    }
  }
  return undefined;
}

/** A lazy tripwire for an unregistered block reference: a real
 *  AgencyFunction (so restore succeeds and the frame slot is filled) whose
 *  body throws a precise error IF anything invokes it. In every correct
 *  replay the generated def body overwrites the slot with a fresh block
 *  before any call, so this never fires. Plain `new` on purpose — the stub
 *  must NOT self-register the way AgencyFunction.create does. */
function makeBlockStub(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: () => {
      throw new Error(
        `Block "${name}" from module "${module}" crossed a serialization ` +
          `boundary and was invoked before replay rebound it. This is a ` +
          `runtime bug — please report it.`,
      );
    },
    params: [],
    toolDefinition: null,
  });
}

/** A lazy reference for an unregistered lifted-callback name: a real
 *  AgencyFunction (so restore succeeds and the frame slot round-trips —
 *  serialize() reads only name/module, so serialize(revive(x)) === x)
 *  whose body resolves the registry AT INVOKE TIME and delegates. In the
 *  embedding process (a parent holding a child's checkpoint) it is never
 *  invoked, only re-serialized. In a process that owns the module, the
 *  direct lookup wins and this is never even constructed. Plain `new` on
 *  purpose — must NOT self-register under the real name.
 *
 *  Delegation preserves the callback calling convention: the hook
 *  dispatcher invokes via `{ type: "positional", args: [eventData] }`, and
 *  this fn declares the same single `data` param the lifted def declares,
 *  then forwards its received positional args verbatim to the resolved
 *  function's own invoke. No stack frame is pushed here (frames are pushed
 *  by generated impl bodies via setupFunction, and this fn is a plain
 *  arrow), so a callback fired through a lazy ref runs at the same frame
 *  depth as one fired through its fresh registration.
 *
 *  Lifted callback registrations never carry bound params (codegen
 *  registers the bare def), so this factory deliberately does not support
 *  the bound-params reconstruction branch of revive().
 *
 *  CORRECTNESS ASSUMPTION: `reviver.registry` must be the persistent LIVE
 *  registry — in production it is aliased once at module load to the global
 *  `__toolRegistry` and never nulled or swapped. If a future change ever
 *  set the reviver's registry transiently per deserialize and cleared it
 *  after restore, every late fire would wrongly hit the throw below for a
 *  callback that is actually resolvable. The "late registration" unit test
 *  pins this behavior. Resolution goes through lookupInRegistry, the same
 *  lookup revive() uses, so legacy bare-name-keyed registries resolve at
 *  fire time exactly as they do at revive time. */
function makeLazyCallbackRef(
  name: string,
  module: string,
  reviver: FunctionRefReviver,
): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: async (...args: unknown[]) => {
      const real = reviver.registry
        ? lookupInRegistry(reviver.registry, name, module)
        : undefined;
      if (!real) {
        const msg =
          `Callback "${name}" from module "${module}" crossed a process ` +
          `boundary and was fired before its module was loaded (or the ` +
          `callback was removed since this state was serialized).`;
        emitFunctionRefMissError(name, msg);
        throw new Error(msg);
      }
      return real.invoke({ type: "positional", args });
    },
    params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
    toolDefinition: null,
  });
}

/** A serialization-preserving tripwire for a ref whose function is in no
 *  loaded module: params, tool description, preapproval, and originalName
 *  are rebuilt from the serialized fields so serialize(revive(x)) === x —
 *  the ref can ride through this process (a parent holding an embedded
 *  child checkpoint, #652) and revive intact in the process that owns the
 *  module. Unlike callbacks, nothing fires these spontaneously, so the
 *  body throws instead of resolving lazily: if the direct lookup missed,
 *  the module genuinely is not loaded here, and a call must surface that.
 *  Plain `new` on purpose — must NOT self-register under the real name. */
function makeUnresolvedFunctionStub(
  name: string,
  module: string,
  value: Record<string, unknown>,
): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    originalName:
      typeof value.originalName === "string" ? value.originalName : name,
    fn: () => {
      const msg =
        `Function "${name}" from module "${module}" crossed a serialization ` +
        `boundary into a process that never loaded its module, and was ` +
        `invoked there (or the function was removed since this state was ` +
        `serialized).`;
      emitFunctionRefMissError(name, msg);
      throw new Error(msg);
    },
    params: Array.isArray(value.params) ? (value.params as FuncParam[]) : [],
    toolDefinition:
      typeof value.toolDescription === "string"
        ? { name, description: value.toolDescription, schema: null }
        : null,
    isPreapproved: value.isPreapproved === true,
  });
}

/** Surface an unresolvable fire in the trace, not only the terminal.
 *  fireWithGuard catches the throw and console.errors it, which is
 *  invisible after the fact; the Statelog error event makes the dropped
 *  callback findable. Best-effort: `agencyStore.getStore()` is undefined
 *  outside any runtime frame (e.g. a bare unit test), and no client means
 *  nothing to emit to — the caller throws the real error either way. */
function emitFunctionRefMissError(name: string, msg: string): void {
  agencyStore.getStore()?.ctx?.statelogClient?.error?.({
    errorType: "runtimeError",
    message: msg,
    functionName: name,
  });
}
