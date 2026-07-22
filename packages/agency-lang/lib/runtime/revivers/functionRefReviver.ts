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

    const original = this.findInRegistry(name, module);

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

  private findInRegistry(name: string, module: string): AgencyFunction {
    // Fast path: direct lookup by composite `${module}:${name}` key.
    const direct = this.registry![`${module}:${name}`];
    if (direct && direct.name === name && direct.module === module) {
      return direct;
    }

    // Slow path: linear scan covers two legacy cases — older `.js`
    // output that keyed by bare name, and any future keying scheme
    // collisions. Either way the function identity check is authoritative.
    for (const entry of Object.values(this.registry!)) {
      if (entry.name === name && entry.module === module) {
        return entry;
      }
    }

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
    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
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
 *  the bound-params reconstruction branch of revive(). */
function makeLazyCallbackRef(
  name: string,
  module: string,
  reviver: FunctionRefReviver,
): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: async (...args: unknown[]) => {
      const real = reviver.registry?.[`${module}:${name}`];
      if (!real) {
        const msg =
          `Callback "${name}" from module "${module}" crossed a process ` +
          `boundary and was fired before its module was loaded (or the ` +
          `callback was removed since this state was serialized).`;
        emitLazyCallbackMissError(name, msg);
        throw new Error(msg);
      }
      return real.invoke({ type: "positional", args });
    },
    params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
    toolDefinition: null,
  });
}

/** Surface an unresolvable fire in the trace, not only the terminal.
 *  fireWithGuard catches the throw and console.errors it, which is
 *  invisible after the fact; the Statelog error event makes the dropped
 *  callback findable. Best-effort: `agencyStore.getStore()` is undefined
 *  outside any runtime frame (e.g. a bare unit test), and no client means
 *  nothing to emit to — the caller throws the real error either way. */
function emitLazyCallbackMissError(name: string, msg: string): void {
  agencyStore.getStore()?.ctx?.statelogClient?.error?.({
    errorType: "runtimeError",
    message: msg,
    functionName: name,
  });
}
