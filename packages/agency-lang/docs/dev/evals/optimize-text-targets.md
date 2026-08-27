# Text targets in the optimizer

How a free-text `optimize` target (a prompt) travels between the source
file and the mutator model, and the one rule that keeps the trip simple.

## The rule

Every `${...}` in the text a mutator model returns is an interpolation.

The model sees the target as plain text, with the target's interpolations
rendered as `${expr}`:

```
optimize const greeting = "Hello, ${name}. Reply in ${language}."
```

is shown as

```
Hello, ${name}. Reply in ${language}.
```

and the model sends its replacement back in the same form: plain text,
no quotes, real line breaks. There is no escaping in either direction.

## The pipeline

Discovery (`lib/optimize/targets.ts`) parses the source file once. For a
text target it stores two things on the `OptimizeTarget`: `value`, the
plain text above, and `interpolations`, the list of interpolation
expressions as source text, printed by the Agency generator so that
`format("x")` and `format(x)` stay distinct. The list comes from the real
parse of the real literal, so it is never re-derived from text.

A reply goes through `lib/optimize/validation.ts`:

1. `parseReplacementText` walks the text. Everything up to the next
   `${` is a text segment, taken as is; each `${` is handed to the
   interpolation parser. A `${...}` that does not hold an expression
   fails here.
2. `compareInterpolations` checks the reply's list against the target's:
   same placeholders, same count, none added.

Either failure goes back to the model as retry feedback. A reply that
passes becomes a `string` or `multiLineString` node, and the Agency
generator writes it into the source with whatever escapes the text needs
(`\"""` for a triple quote inside a block, `\"` inside a plain string).
The optimizer never escapes anything itself. A multi-line reply is
written as a `"""` block unless the block form cannot hold it: text that
ends in `"` would run into the closing delimiter, and text that ends in
`\` would escape whatever follows it. Those replies use a plain string.

## What the rule gives up

A prompt that wants to show `${` as text cannot be an optimize target:
the model's copy of it reads as a placeholder the target does not have,
and the reply is rejected. `literalInterpolationWarnings` reports such a
target once at the start of a run. Say it another way, such as
"dollar-brace interpolation".

## Why not parse the reply as an Agency literal

That would need the model to write the quotes and the escapes. A model
that can improve a prompt cannot always be trusted to escape it, and an
earlier version of this code grew five recovery paths for the ways it
got that wrong. Plain text in both directions removes the question.
