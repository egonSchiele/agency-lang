import type { DiagnosticName } from "./diagnostics.js";

/**
 * Long-form explanation per diagnostic, in Markdown.
 *
 * EXHAUSTIVE BY TYPE: `Record<DiagnosticName, string>` — adding a registry
 * entry without an explanation here is a COMPILE error, not a test failure.
 * That is the whole point; never weaken this to Partial or Record<string,…>.
 *
 * A retired/deprecated registry entry STILL needs an explanation here — the
 * docs keep explaining a code a user may still see from an older compiler.
 * Do not "clean up" an entry when a diagnostic is retired.
 *
 * Convention per entry: one short what/why paragraph, then fix guidance.
 * 2-4 sentences for most; longer for high-traffic codes (assignability,
 * undefined names, strict member access, exhaustiveness). A small Agency
 * example is welcome but MUST parse — fence it as ```agency and it is
 * verified by diagnosticExplanations.test.ts. A snippet that shows WRONG
 * code must NOT be tagged ```agency (use a plain fence) so the parser gate
 * skips it. Do NOT quote a raw message template with live {placeholders};
 * write concrete values instead, and keep any braces inside a code span
 * (the leak test rejects an unrendered {word} outside code).
 */
export const DIAGNOSTIC_EXPLANATIONS: Record<DiagnosticName, string> = {
  // ---- AG1: types and aliases ----
  typeParamDefaultOrder: `A type alias lists its type parameters left to right, and — like default function arguments — every parameter with a default must come after the parameters that have none. Otherwise a caller who omits a middle argument leaves a later, required one with no way to be positioned.

**How to fix:** reorder the type parameters so all defaulted ones are last.`,

  notValueParameterized: `Some type aliases take *value* arguments in parentheses (like a validated length), and some take none. This fires when you passed value arguments to an alias that accepts none.

**How to fix:** drop the parenthesized arguments, or point at the alias you actually meant to parameterize.`,

  tooManyValueArgs: `A value-parameterized alias accepts a fixed maximum number of value arguments, and you supplied more than it declares.

**How to fix:** remove the extra arguments, or check whether you meant a different alias with more parameters.`,

  valueArgsRequired: `This alias is value-parameterized: it needs its value arguments supplied in parentheses before it can be used as a type. Writing the bare name leaves those parameters unfilled.

**How to fix:** call it with its arguments, following the form the message shows for that alias.`,

  tooFewValueArgs: `A value-parameterized alias requires at least some minimum number of value arguments, and you supplied fewer.

**How to fix:** add the missing arguments; the message names how many the alias needs.`,

  unknownTypeAlias: `A type name was used that has no \`type\` declaration in scope and is not a built-in type. The checker resolves every type name against the aliases visible in the file plus its imports.

**How to fix:** declare the alias, import it from the module that defines it, or fix a typo in the name.`,

  bareArmBinderShadowsType: `An un-guarded match arm whose left side is a bare name matches ANY value and binds it to that name — it never tests the type, even when the name is a type in scope. Writing \`Person => ...\` therefore does something very different from testing "is this a Person".

**How to fix:** to test the type and bind, write \`p: Person => ...\`; to test only, write \`is Person => ...\`; to genuinely bind whatever arrives, pick a name that is not a type.`,

  propertyBinderShadowsType: `Inside an object pattern, \`{field: name}\` binds the field to a new variable called \`name\` — it does not test the field's type, even when the name is a type in scope. \`{name: string}\` binds the \`name\` field to a variable called \`string\`.

**How to fix:** field-level type tests are not supported; test the whole value against a typed shape instead (\`p: Person => ...\` or an inline object type), or pick a binder name that is not a type.`,

  typePatternUnknownType: `A type pattern (\`x is T\`, or a match arm \`p: T\`) named something that is not a type. After \`is\`, a bare identifier is always read as a type reference — the old always-true binder form was retired — so a variable name or a JavaScript class name (like \`Date\`) in that position is an error rather than a silent match-anything.

**How to fix:** if you meant a type, declare or import it. If you meant to bind the value, write \`const name = x\` instead. For JavaScript classes, use \`is object\` or a helper function — type patterns only test Agency types.`,

  genericRequiresTypeArgs: `This is a generic type — it is parameterized by other types (like the element type of a list) — and it cannot be used bare. The type arguments are required.

**How to fix:** supply the type arguments in angle brackets, e.g. write the element type the generic wraps.`,

  builtinGenericArity: `A built-in generic type (such as an array or Record) was given the wrong number of type arguments. Each built-in generic takes an exact count.

**How to fix:** supply exactly the number of type arguments the message names.`,

  unknownGenericType: `A generic type name was used with type arguments, but no generic type by that name is defined or imported.

**How to fix:** define or import the generic, or fix the name.`,

  notGenericType: `Type arguments in angle brackets were applied to a name that is not a generic type, so it has no parameters to fill.

**How to fix:** remove the type arguments, or reference the generic type you meant.`,

  tooManyTypeArgs: `A generic type accepts a fixed maximum number of type arguments, and you supplied more than it declares.

**How to fix:** remove the extra type arguments.`,

  tooFewTypeArgs: `A generic type requires at least some minimum number of type arguments, and you supplied fewer.

**How to fix:** add the missing type arguments; the message names how many are needed.`,

  // ---- AG2: assignability and checking ----
  typeNotAssignableInContext: `Agency assigns each value a type and checks that it fits where you use it. This is the assignability error with the surrounding context named (a return, an argument, a field) — the value's type does not fit that slot.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be several types, declare the slot as a union.`,

  conditionNotBoolean: `The condition of an \`if\` or \`while\` must be a boolean. Agency does not treat non-boolean values as truthy or falsy, so a number or string here is an error rather than a silent coercion.

**How to fix:** compare explicitly — e.g. \`count > 0\` instead of \`count\`, or \`name != ""\` instead of \`name\`.`,

  unknownProperty: `An object literal (or similar structured value) included a key that the target type does not declare. The checker knows the exact shape the context expects and rejects keys outside it.

**How to fix:** remove the stray key, fix a typo in the key name, or add the field to the target type if it belongs there.`,

  missingAnnotationStrictMode: `In strict mode every variable needs a type annotation; this one has none and its type could not be inferred with certainty. Strict mode trades a little verbosity for catching type mistakes early.

**How to fix:** add an annotation, e.g. \`let total: number = …\`, or turn strict mode off if you do not want this requirement.`,

  typeNotAssignable: `Agency assigns each value a type and checks that the value you store, return, or pass matches the type the destination expects. This error fires when they disagree — for example putting a \`string\` where a \`number\` is required.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be one of several types, declare the destination as a union.

\`\`\`agency
def half(n: number): number {
  return n / 2
}

node main() {
  const count: number = 3
  half(count)
}
\`\`\``,

  forLoopIterableType: `A \`for (x in xs)\` loop iterates an array or a Record; the value after \`in\` here is neither. The checker needs a container it knows how to walk.

**How to fix:** iterate an array or Record, or convert the value into one before the loop.

\`\`\`agency
node main() {
  const names = ["ada", "grace"]
  for (name in names) {
    print(name)
  }
}
\`\`\``,

  validatedParamsRequireResult: `A parameter marked with \`!\` validation can short-circuit the call with a failure when the data does not pass. A function that can fail must advertise it in its return type, so its return type must be a \`Result\`.

**How to fix:** change the return type to \`Result<...>\`, or remove the \`!\` validation from the parameters if the call cannot fail.`,

  docStringParamInterpolation: `A function's doc string becomes the tool description sent to the LLM, and that description is fixed before any call happens — so a parameter's runtime value is not available to interpolate into it.

**How to fix:** reference a global variable instead of a parameter, or reword the doc string to not depend on per-call values.`,

  unionFieldNotOnEveryMember: `The value has a union type, and the field you accessed exists on some members of the union but not all. Reading it directly would be unsafe on the members that lack it.

**How to fix:** narrow the value first — for example with a guard that establishes which member you have — then access the field inside that narrowed branch.`,

  resultBranchFieldAccess: `A \`Result\` is either a success or a failure, and the field you accessed only exists on one of those branches. Reading it without first checking which branch you have would be unsafe.

**How to fix:** guard with \`if (isSuccess(r))\` or \`if (isFailure(r))\`, use \`r catch …\`, or handle both arms with \`match\`.

\`\`\`agency
node main() {
  const r = compute()
  if (isSuccess(r)) {
    print(r.value)
  }
}
\`\`\``,

  dimensionMismatch: `Agency tracks physical dimensions (like duration versus size) on some values and refuses arithmetic that mixes incompatible ones, the way you cannot add seconds to bytes. This caught an operation on two different dimensions.

**How to fix:** operate on values of the same dimension, or convert one so both agree before combining them.`,

  propertyDoesNotExist: `The property you accessed is not declared on the value's type. The checker knows the type's shape and only allows the fields it declares.

**How to fix:** fix a typo in the property name, access a field the type actually has, or add the field to the type if it belongs there.`,

  notAllPathsReturn: `The function declares a return type, so every path through its body must produce a value — but at least one path (often a missing \`else\`, or a fall-through past a loop) reaches the end without returning.

**How to fix:** add a \`return\` on the path that is missing one, or a final \`return\` that covers the fall-through.`,

  // ---- AG3: interrupts, effects, and handlers ----
  handlerParamValidated: `Handler parameters carry the payload of an interrupt, and the \`!\` validation syntax is not allowed on them. Validation there would run at a point in the flow where a failure has nowhere safe to go.

**How to fix:** drop the \`!\` from the handler parameter and validate the data inside the handler body if you need to.`,

  effectDeclaredTwice: `An effect was declared more than once in the same file. Each effect name should be introduced by a single declaration so its payload shape has one definition.

**How to fix:** remove the duplicate declaration.`,

  effectPayloadConflict: `Two declarations of the same effect disagree about its payload type. Every declaration of an effect must agree on the data it carries.

**How to fix:** make the declarations match, or consolidate them into one.`,

  namedArgsOnRaise: `\`raise\` and \`interrupt\` take their payload positionally, not as named arguments. Their data is a single positional value.

**How to fix:** pass the data positionally, e.g. \`raise MyEffect(payload)\`.`,

  effectDataMissing: `The effect declares a payload, but this \`raise\`/\`interrupt\` supplied none. A declared payload is required at the raise site.

**How to fix:** pass the data the effect expects.`,

  effectDataFieldMissing: `The effect's payload is a structured type, and a required field of it was not supplied at the raise site.

**How to fix:** add the missing field to the payload you pass.`,

  effectDataFieldWrongType: `A field of the effect's payload was supplied with a value whose type does not match what the effect declares for that field.

**How to fix:** pass a value of the declared type for that field.`,

  effectDataMismatch: `The payload supplied at the raise site does not match the shape the effect declares. The whole value, not just one field, is off.

**How to fix:** construct the payload to match the effect's declared type.`,

  unhandledInterrupts: `This function may raise interrupts, but it is called from a place that is not inside a matching handler. An unhandled interrupt at runtime has no \`handle\` block to receive it. This is a warning because the handler may be installed dynamically at a point the checker cannot see.

**How to fix:** wrap the call in a \`handle\` block for the effects it may raise, or confirm a handler is installed higher up.`,

  handlerBodyRaises: `RETIRED. Handler functions may raise interrupts: a handler never hears its own raises (the dispatcher skips the executing handler entry), so the recursion this diagnostic guarded against cannot happen. The raise is decided by the rest of the chain — an outer handler or an explicit \`with approve\` — and a raise nothing settles is rejected with an explanatory message, because a handler cannot pause to ask the user.

**How to fix:** nothing — code this diagnostic used to flag is now legal. If you suppressed it with \`// @tc-ignore AG3010\`, remove the suppression. See the handlers guide for the full rules.`,

  interruptInCallback: `Callbacks fire as side effects at points where execution cannot pause, so their body may not \`interrupt\` — an interrupt would need to stop the run to ask the user something, which a callback has no way to do.

**How to fix:** move the \`interrupt\` into the calling node or function. If you only wanted a runtime budget check, use a runtime guard instead.`,

  raisesNotAnEffectSet: `A \`raises\` clause must name an effect set, but the reference given is declared as a plain \`type\`, not an \`effectSet\`. The two are different: only an effect set enumerates raisable effects.

**How to fix:** declare the reference with \`effectSet\` instead of \`type\`, or use an inline effect set in angle brackets.`,

  raisesExceeded: `The function or node raises an effect that its own \`raises\` clause does not list. The clause is a contract: it must cover every effect the body can raise.

**How to fix:** add the effect to the \`raises\` clause, or stop raising it.`,

  valueMayRaiseAnyEffect: `A value is being used where the target type limits which effects may be raised, but the value's own type has no \`raises\` clause — so it could raise anything, which exceeds that limit.

**How to fix:** add a \`raises\` clause to the value's type so the checker can see it stays within bounds.`,

  valueEffectExceedsRaises: `A value raises an effect that the target type's \`raises\` clause does not allow. The target restricts the effect set, and this value steps outside it.

**How to fix:** add the effect to the target type's clause, or use a target type that permits it.`,

  // ---- AG4: names, scope, and reserved words ----
  shadowsImportedFunction: `A local name here has the same name as a function you imported, so the local shadows the import within this scope. That is legal but often unintended, so it is flagged as a warning.

**How to fix:** rename the local if you meant to keep using the import, or ignore the warning if the shadow is deliberate.`,

  reservedBuiltinRedefined: `The name is a reserved built-in and cannot be redefined. Built-ins are part of the language surface; redefining one would make its ordinary uses ambiguous.

**How to fix:** choose a different name for your definition.`,

  reservedBuiltinTypeRedefined: `The name is a reserved built-in type and cannot be redefined for the same reason built-in functions cannot: its ordinary uses must stay unambiguous.

**How to fix:** pick a different type name.`,

  undefinedFunction: `A function was called that has no definition in scope and is not a built-in. The checker resolves every call against the functions visible in the file plus its imports.

**How to fix:** define the function, import it from the module that provides it, or fix a typo in the call.`,

  importNameNotFound: `An import names a symbol that its target Agency module does not define. The checker resolves every \`import { ... }\` (and \`import node { ... }\`) against the actual exports of the file it points to, so a name the file never declares — often a typo, or a symbol that was renamed or removed — is an error.

**How to fix:** import a name the module actually defines, correct the spelling, or add the missing definition to the target file. Unlike an undefined bare call (which might be an uncatalogued JavaScript global), an Agency import is unambiguous, so this always errors.`,

  importModuleNotFound: `An import points at a module that does not resolve to any file. The path — a relative \`./…\` path, a \`std::\` module, or a \`pkg::\` package — was resolved the same way the compiler resolves it, and nothing exists there.

**How to fix:** correct the path, create the missing file, or install the package that provides it. Agency imports must resolve to a real module.`,

  importNameNotExported: `An import names a symbol that its target module defines but does not \`export\`. A plain \`import { ... }\` can only see \`export\`ed functions, types, and constants — a bare \`def\`/\`type\` without \`export\` is module-private. (Nodes are the exception: they are importable without \`export\`.) The compile path already rejects this; the type checker reports it too.

**How to fix:** add the \`export\` keyword to the definition in the target file, or import a symbol that is exported.`,

  reassignToConst: `A \`const\` binding is fixed after its initial value: it cannot be reassigned. This assignment targets a name that was declared \`const\`.

**How to fix:** declare it with \`let\` if it needs to change, or assign to a different variable.

\`\`\`agency
node main() {
  let count = 0
  const limit = 10
  count = count + 1
}
\`\`\``,

  reservedBlockKeyword: `This keyword introduces a block directly — you write it followed by braces (or parentheses then braces) — and it does not support an \`as\` binding, because there is nothing to bind. The \`as\` here is not valid on this block form.

**How to fix:** write the block without \`as\`, e.g. the keyword followed immediately by its \`{ ... }\` body.`,

  undefinedVariable: `The type checker walks every scope — nodes, function bodies, blocks — and resolves each name to a declaration. This error means a name was used with no \`let\`, \`const\`, parameter, or import that introduces it in reach.

**How to fix:** declare it before use (\`let x = …\` / \`const x = …\`), fix a typo in the name, or import it if it lives in another module. Agency has no implicit variables: a bare assignment like \`x = 5\` without a prior \`let\`/\`const\` is not a declaration.`,

  // ---- AG5: match and narrowing ----
  matchNotExhaustive: `A \`match\` over a union or Result must handle every case the scrutinee can take; the checker computes the set of arms you covered and reports the ones missing. An unhandled case would fall through at runtime with no branch to run.

**How to fix:** add an arm for each listed missing case, or add a wildcard \`_\` arm if a catch-all is genuinely what you want.

\`\`\`agency
node main() {
  const r = compute()
  match (r) {
    is success(v) { print(v) }
    is failure(e) { print(e) }
  }
}
\`\`\``,

  // ---- AG6: calls, tools, and LLM usage ----
  regexInStructuredOutput: `An \`llm()\` call returns its result as structured JSON, and a \`regex\` value has no JSON representation the model can produce — so \`regex\` may not appear anywhere in an \`llm()\` output type.

**How to fix:** return the matched text as a \`string\` (or another JSON-friendly type) and build the regex yourself afterward.`,

  partialRequiresNamedArgs: `\`.partial()\` binds arguments by name so it is unambiguous which parameters you are fixing. It does not accept positional arguments.

**How to fix:** name the arguments, e.g. \`fn.partial(a: 5)\`.`,

  unknownPartialParameter: `A \`.partial()\` call named a parameter that the function does not have. Binding an unknown parameter has no meaning.

**How to fix:** bind one of the function's real parameters (the message lists them), or fix a typo.`,

  partialArgNotAssignable: `An argument passed to \`.partial()\` has a type that does not match the parameter it binds. A partially-applied argument must still satisfy the parameter's type.

**How to fix:** pass a value of the parameter's declared type.`,

  namedArgsOnBuiltinMethod: `Built-in methods take their arguments positionally; named arguments are only supported on Agency-defined functions. This call used names on a built-in method.

**How to fix:** pass the arguments positionally.`,

  methodArityExact: `A built-in method was called with the wrong number of arguments; this method takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.`,

  methodArityAtLeast: `A built-in method was called with too few arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.`,

  methodArityRange: `A built-in method accepts a range of argument counts, and this call fell outside it.

**How to fix:** pass a number of arguments within the range the message names.`,

  builtinMethodArgNotAssignable: `An argument to a built-in method has a type that does not match the parameter it fills.

**How to fix:** pass a value of the expected type.`,

  namedArgsOnlyAgencyFunctions: `Named arguments work only with functions defined in Agency. The target here is not one of those (for example a built-in or an imported host function), so its arguments must be positional.

**How to fix:** pass the arguments positionally.`,

  namedArgNotAccepted: `A named argument was supplied that the function does not declare. The checker knows the function's parameter names and rejects names outside that set.

**How to fix:** use one of the function's declared parameter names (the message lists the allowed ones), or fix a typo.`,

  duplicateNamedArg: `The same named argument was supplied twice in one call. Each parameter can be bound at most once.

**How to fix:** remove the duplicate.`,

  namedArgTypeMismatch: `A named argument's value has a type that does not match the parameter's declared type.

**How to fix:** pass a value of the expected type for that parameter.`,

  blockArgNotAccepted: `A block argument (a trailing \`{ ... }\`) was passed to a function that does not declare a block parameter.

**How to fix:** remove the block, or call a function that takes one.`,

  callArityExact: `A function was called with the wrong number of positional arguments; it takes an exact count.

**How to fix:** pass exactly the number of arguments the message names.`,

  callArityAtLeast: `A function was called with too few positional arguments; it requires at least a minimum number.

**How to fix:** supply at least the number of arguments the message names.`,

  callArityRange: `A function accepts a range of argument counts (some parameters have defaults or are variadic), and this call fell outside that range.

**How to fix:** pass a number of arguments within the range the message names.`,

  argNotAssignable: `A positional argument's type does not match the parameter it fills. Each argument must be assignable to its parameter's type.

**How to fix:** pass a value of the expected type, or adjust the parameter's type if the call is correct.`,

  splatMustBeArray: `A splat argument (\`...xs\`) spreads an array's elements into positional arguments, so the splatted value must be an array. This value is not.

**How to fix:** splat an array, or convert the value into one first.`,

  splatElementNotAssignable: `The array being splatted has an element type that does not match the parameters the elements would fill.

**How to fix:** splat an array whose element type matches the target parameters.`,

  pipeSlotNotAssignable: `A pipe feeds its left-hand value into a slot on the right, and that value's type does not match the slot's type.

**How to fix:** pipe a value of the slot's type, or transform it before the pipe.`,

  splatAfterNamedArg: `A splat argument cannot come after a named argument in a call. The splat fills positional slots, and those are resolved before names.

**How to fix:** move the splat ahead of any named arguments.`,

  positionalAfterNamedArg: `Once a call uses a named argument, every following argument must also be named — a positional argument cannot come after a named one.

**How to fix:** move positional arguments before the named ones, or name them too.`,

  unknownNamedArg: `A named argument in this call does not correspond to any parameter of the function.

**How to fix:** use a declared parameter name, or fix a typo.`,

  namedArgConflictsPositional: `A parameter was filled both positionally and by name in the same call, so it is bound twice.

**How to fix:** supply the argument once — either positionally or by name, not both.`,

  positionalFeedsNamedVariadic: `A positional argument would feed a variadic parameter that is also being bound by name in the same call. The parameter cannot collect positionals and take a named value at once.

**How to fix:** bind the variadic parameter one way — either by name or with positional arguments.`,

  toolRequiredParamUnbound: `A function passed as a tool has a required function-typed parameter that is still unbound. The LLM cannot supply a function value, so a required function parameter must be fixed before the function becomes a tool.

**How to fix:** bind it first with \`.partial(...)\` — e.g. \`fn.partial(callback: myImpl)\` — then pass the result as the tool.`,

  toolRequiredParamUnboundTyped: `This is the same problem as an unbound required function-typed tool parameter, with the parameter's function type shown. The LLM cannot provide a function value, so the parameter must be bound before the function is used as a tool.

**How to fix:** bind it with \`.partial(...)\` before passing the function as a tool.`,

  toolOptionalParamsDropped: `A function passed as a tool has optional function-typed parameters that the LLM cannot fill, so they are dropped and the tool runs with each parameter's declared default. This is a warning, not an error, because a default exists — but the body must be prepared to run without those functions.

**How to fix:** confirm the defaults are correct for the tool use, or bind the parameters explicitly with \`.partial(...)\` if you need specific implementations.`,

  saveDraftAtTopLevel: `\`saveDraft(v)\` records a best-so-far value for the scope that calls it, so an enclosing \`guard(...)\` can return that value if it trips. At module top level there is no enclosing scope: nothing could ever read the draft, and the runtime rejects the call for the same reason.

**How to fix:** move the \`saveDraft\` call inside the function, node, or \`guard\` block whose result it is a draft of.`,

  finalizeInterrupts: `An interrupt pauses the program and waits for an answer. When the answer arrives, the program resumes from the paused step. A finalize block runs while an abort shuts its scope down, so there is no step to resume from. That is why a finalize cannot interrupt, and cannot call a function that interrupts.

The check follows calls into functions defined in your own files. It cannot see into imported functions. If an imported function interrupts inside a finalize at runtime, the finalize counts as failed and the scope falls back to its saved draft.

**How to fix:** only compute values inside the finalize, using the variables you already have. If you need to ask the user something, ask in the normal body, before the work that can trip.`,

  finalizeDuplicate: `When a scope is stopped, one finalize computes its partial result. A second finalize block would leave the result ambiguous.

**How to fix:** combine the logic into one finalize block. Branch inside it if you need to.`,

  finalizeNotTopLevel: `A finalize is a declaration, not a statement. If the scope has one, it is always active. Nesting it inside an \`if\`, a loop, or a match arm would arm it conditionally, and the language would then need to track whether it was armed. The language avoids that bookkeeping.

**How to fix:** move the finalize to the top level of the function or block body. Put it last, by convention. Branch inside the finalize instead.`,

  finalizeSaveDraft: `Inside a finalize, you are computing the scope's partial result right now. The value the finalize returns is that result. Saving a draft there does nothing.

**How to fix:** \`return\` the value from the finalize instead of calling \`saveDraft\`.`,

  finalizeInNode: `An enclosing \`guard\` consumes salvaged partial results, and a guard cannot span nodes. Above a node there is only the graph engine, and the graph engine does not consume partials. A finalize declared directly in a node body would compute a value nobody reads.

**How to fix:** put the finalize inside the function or \`guard\` block that does the guarded work.`,

  finalizeReturnShape: `Suppose a guard stops a call that sits inside a return expression. The surrounding expression consumes the stopped call's result before any check can run: the result gets concatenated, wrapped in an array, and so on. The finalize would be skipped and the function would return garbage.

A direct \`return f(x)\` is safe, because the compiler intercepts it. Method and index calls do not count as direct: \`return obj.method()\` and \`return arr[i]()\` need the same fix as any other complex return. Nothing more complex than a single direct call can be intercepted without changing evaluation order.

**How to fix:** assign the call to a local first, then return the local:

\`\`\`agency
def f(): string {
  const part = verify()
  return "combined: " + part

  finalize {
    return "partial: " + part
  }
}
\`\`\``,

  finalizeBinderCollision: `A finalize body runs in the same variable scope as the function or block it belongs to. The \`as\` binder adds one extra name: the scope's saved draft. If that name already belongs to a parameter or local, references inside the finalize could not tell the two apart, and the draft would silently win or lose depending on compilation details.

**How to fix:** rename the binder. Any name not already used in the scope works: \`finalize as draft { ... }\`.`,

  finalizeBinderArity: `The \`as\` clause on a finalize binds what the abort yields to the block, and the abort yields exactly one thing: the scope's saved draft (or null when nothing was saved). There is no second value to bind, so a parameter list has no meaning here. The shared block-argument grammar is why the parser accepts the list at all.

**How to fix:** keep one binder: \`finalize as draft { ... }\`. Everything else the finalize needs is already in scope as ordinary locals.`,

  // ---- AG7: static init, config, and imports ----
  exportRequiresStaticConst: `Only \`static const\` declarations can be exported from a module. A plain \`const\`, \`let\`, or other declaration is per-run state and is not part of a module's public surface.

**How to fix:** declare the exported value as \`static const\`, or remove the \`export\`.`,

  bannedBuiltinInStaticInit: `Static initializers run once at process startup, before any per-run state exists — so they may not call built-ins that need a running agent (LLM calls, I/O, and similar). This static init calls one of those.

**How to fix:** move the call into a node, or into a function called from a node, where per-run state is available.`,

  interruptInStaticInit: `Interrupts pause the per-run execution stack, but static initializers run once at startup before any run has begun — there is no stack to pause. So \`interrupt(...)\` is not allowed in a static initializer.

**How to fix:** move the \`interrupt\` into a node body.`,

  staticReassignedAtTopLevel: `Statics are immutable after they initialize, so a static cannot be reassigned at module top level. Reassigning one would break the guarantee that its value is fixed for the whole process.

**How to fix:** use a global (\`const\` or \`let\` without \`static\`) if you need a value that changes.`,

  staticMutatedViaMethod: `Statics are deep-frozen after initialization, so mutating one through a method (like \`.push(...)\`) at module top level is not allowed — the frozen value rejects the change.

**How to fix:** use a global (\`const\` or \`let\` without \`static\`) if you need a mutable value.`,

  conflictingMarkers: `A function was marked both \`destructive\` and \`idempotent\`, but those markers contradict each other: destructive means a retry can cause additional effects, while idempotent means a retry is safe to repeat. A function cannot be both.

**How to fix:** keep the one marker that describes the function and remove the other.`,
};
