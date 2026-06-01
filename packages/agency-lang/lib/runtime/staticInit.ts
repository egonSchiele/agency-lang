/**
 * Static-variable initialization safety net.
 *
 * Agency's `static const` declarations are compiled to module-level
 * `let` bindings whose assignment happens inside a per-module init
 * function (`__initializeStatic`). Until that function runs, the
 * binding holds an unset value. Historically it was plain `undefined`,
 * which meant a cross-module read before init silently produced
 * `undefined` and propagated through expressions like
 * `fooStatic = barStatic + "!"` as `"undefined!"`.
 *
 * To turn that silent failure into a loud one:
 *
 *   1. Codegen initializes every `static const` binding to
 *      `__UNINIT_STATIC` (a unique sentinel value).
 *   2. Codegen wraps every *read* of a static name with
 *      `__readStatic(value, name, moduleId)`.
 *   3. `__readStatic` returns the value unchanged if it's not the
 *      sentinel, or throws a clear error if it is.
 *
 * The wrapper is transparent — `__readStatic(x, ...)` evaluates to the
 * same value `x` would have, so binary operations, template
 * interpolations, indexing, and spreads all continue to work without
 * any change to user code or generated expression shapes.
 */

const UNINIT_STATIC_SYMBOL = Symbol("agency.static.uninit");

/**
 * Sentinel assigned to `static const` bindings before their initializer
 * runs. Tagged with a unique symbol so it cannot collide with any user
 * value, including `undefined`, `null`, `NaN`, `0`, `""`, other
 * symbols, frozen objects, etc.
 *
 * The codegen references this by name in the emitted source; do not
 * rename without updating the codegen.
 */
export const __UNINIT_STATIC = UNINIT_STATIC_SYMBOL;

/**
 * Read a static variable's current value. Returns `value` unchanged
 * unless it is the uninitialized sentinel — in which case throws a
 * clear error naming the variable and module, with guidance on the
 * common causes.
 *
 * The codegen emits a call to this around every read of a top-level
 * `static const` name. Users never write `__readStatic` directly.
 *
 *   __readStatic(barStatic, "barStatic", "bar.agency") + "!"
 *   `${__readStatic(prompt, "prompt", "x.agency")} world`
 *   __readStatic(items, "items", "x.agency").length
 */
export function __readStatic<T>(
  value: T,
  name: string,
  moduleId: string,
): T {
  if ((value as unknown) === UNINIT_STATIC_SYMBOL) {
    // PR 2's per-variable dep graph will thread the source module id
    // through to every wrap site. Until then, some cross-module wraps
    // emit an empty string here; substitute a placeholder so the
    // message stays readable ("from <unknown module>" rather than
    // "from  before…").
    const where = moduleId ? moduleId : "<unknown module>";
    throw new Error(
      `Tried to read static \`${name}\` from ${where} before its ` +
        `initializer ran.\n\n` +
        `This usually means one of:\n` +
        `  • A circular import where module init order is not well-defined.\n` +
        `  • An indirect read through a function call: a static initializer ` +
        `calls a function that transitively reads this static before this ` +
        `static's own initializer has executed.\n\n` +
        `To fix: break the circular import, or restructure so the static ` +
        `is read only after initialization completes (e.g. inside a node ` +
        `or def, not at the top level of another static initializer).`,
    );
  }
  return value;
}
