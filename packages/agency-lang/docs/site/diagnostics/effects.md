---
name: "Interrupts, effects, and handlers"
---

# Interrupts, effects, and handlers

<a id="ag3001"></a>

## AG3001 — The '!' validation syntax is not allowed on handler parameters. Validate the data inside the handler body if needed.

*Default severity: error.*

Handler parameters carry the payload of an interrupt, and the `!` validation syntax is not allowed on them. Validation there would run at a point in the flow where a failure has nowhere safe to go.

**How to fix:** drop the `!` from the handler parameter and validate the data inside the handler body if you need to.

<a id="ag3002"></a>

## AG3002 — Effect '{effect}' is declared more than once in the same file.

*Default severity: error.*

An effect was declared more than once in the same file. Each effect name should be introduced by a single declaration so its payload shape has one definition.

**How to fix:** remove the duplicate declaration.

<a id="ag3003"></a>

## AG3003 — Conflicting payload types for effect '{effect}'. All declarations of an effect must agree on its payload.

*Default severity: error.*

Two declarations of the same effect disagree about its payload type. Every declaration of an effect must agree on the data it carries.

**How to fix:** make the declarations match, or consolidate them into one.

<a id="ag3004"></a>

## AG3004 — Named arguments are not allowed on 'raise'/'interrupt'. Pass the data positionally.

*Default severity: error.*

`raise` and `interrupt` take their payload positionally, not as named arguments. Their data is a single positional value.

**How to fix:** pass the data positionally, e.g. `raise MyEffect(payload)`.

<a id="ag3005"></a>

## AG3005 — Effect '{effect}' expects data {payload}, but none was supplied.

*Default severity: error.*

The effect declares a payload, but this `raise`/`interrupt` supplied none. A declared payload is required at the raise site.

**How to fix:** pass the data the effect expects.

<a id="ag3006"></a>

## AG3006 — Effect '{effect}' data field '{field}' is missing.

*Default severity: error.*

The effect's payload is a structured type, and a required field of it was not supplied at the raise site.

**How to fix:** add the missing field to the payload you pass.

<a id="ag3007"></a>

## AG3007 — Effect '{effect}' data field '{field}' has the wrong type.

*Default severity: error.*

A field of the effect's payload was supplied with a value whose type does not match what the effect declares for that field.

**How to fix:** pass a value of the declared type for that field.

<a id="ag3008"></a>

## AG3008 — Effect '{effect}' data does not match the declared {payload}.

*Default severity: error.*

The payload supplied at the raise site does not match the shape the effect declares. The whole value, not just one field, is off.

**How to fix:** construct the payload to match the effect's declared type.

<a id="ag3009"></a>

## AG3009 — Function '{fn}' may throw interrupts [{effects}] but is not inside a handler.

*Default severity: warning.*

This function may raise interrupts, but it is called from a place that is not inside a matching handler. An unhandled interrupt at runtime has no `handle` block to receive it. This is a warning because the handler may be installed dynamically at a point the checker cannot see.

**How to fix:** wrap the call in a `handle` block for the effects it may raise, or confirm a handler is installed higher up.

<a id="ag3010"></a>

## AG3010 — Handler {handler} may raise interrupts [{effects}]. That would re-enter the handler chain (the dispatcher visits every handler, even the one currently running) and recurse until `HandlerRecursionError` fires at runtime. Restructure so the handler doesn't call interrupt-raising code (e.g. hoist file I/O out of the handler), or suppress this error with `// @tc-ignore` on the line above the `handle` block.

*Default severity: error.*

A handler that itself raises interrupts would re-enter the handler chain — the dispatcher visits every handler, including the one currently running — and recurse until the runtime aborts with a recursion error.

**How to fix:** restructure so the handler does not call interrupt-raising code (for example, hoist file I/O out of the handler). If you are certain it is safe, suppress with `// @tc-ignore` on the line above the `handle` block.

<a id="ag3011"></a>

## AG3011 — `interrupt` is not allowed inside a callback body (callback registered on '{hook}' may raise [{effects}]). Callbacks fire as side effects; their body cannot pause execution to ask the user a question. Move the `interrupt` into the calling node/function instead, or use a runtime guard if you wanted budget enforcement.

*Default severity: error.*

Callbacks fire as side effects at points where execution cannot pause, so their body may not `interrupt` — an interrupt would need to stop the run to ask the user something, which a callback has no way to do.

**How to fix:** move the `interrupt` into the calling node or function. If you only wanted a runtime budget check, use a runtime guard instead.

<a id="ag3012"></a>

## AG3012 — 'raises {ref}' is not an effect set. Declare '{ref}' with 'effectSet' (not 'type'), or use an inline set like '<...>'.

*Default severity: error.*

A `raises` clause must name an effect set, but the reference given is declared as a plain `type`, not an `effectSet`. The two are different: only an effect set enumerates raisable effects.

**How to fix:** declare the reference with `effectSet` instead of `type`, or use an inline effect set in angle brackets.

<a id="ag3013"></a>

## AG3013 — {kind} '{name}' raises effect '{effect}', which exceeds its declared 'raises {declared}'. Add '{effect}' to the clause.

*Default severity: error.*

The function or node raises an effect that its own `raises` clause does not list. The clause is a contract: it must cover every effect the body can raise.

**How to fix:** add the effect to the `raises` clause, or stop raising it.

<a id="ag3014"></a>

## AG3014 — {who} may raise any effect (its type has no 'raises' clause), which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add a 'raises' clause to the value's type.

*Default severity: error.*

A value is being used where the target type limits which effects may be raised, but the value's own type has no `raises` clause — so it could raise anything, which exceeds that limit.

**How to fix:** add a `raises` clause to the value's type so the checker can see it stays within bounds.

<a id="ag3015"></a>

## AG3015 — {who} raises effect '{effect}', which exceeds the 'raises <{allowed}>' allowed by type '{type}'. Add '{effect}' to the clause, or use a target type that allows it.

*Default severity: error.*

A value raises an effect that the target type's `raises` clause does not allow. The target restricts the effect set, and this value steps outside it.

**How to fix:** add the effect to the target type's clause, or use a target type that permits it.
