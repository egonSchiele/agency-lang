/** The Agency facts card: ground truth the suite's judges carry so they can
 *  tell true claims about Agency from JavaScript-flavored ones. One source,
 *  versioned with the suite — correct it here and every judge improves.
 *  Keep it short and keep every line verifiable against docs/site/guide. */
export const AGENCY_FACTS = `Agency is its own language. It compiles to TypeScript and its syntax looks
like JS/TS, but its idioms differ, and reviews must judge it as Agency:

- == and === are the same operator in Agency: the JS spellings === and
  !== are accepted aliases that compile identically to ==/!= (there is
  no strict-vs-loose distinction, and the formatter keeps whichever
  spelling was written). Neither spelling is an error, and advice to
  switch between == and === is meaningless.
- "for (item in items)" iterates the ELEMENTS of an array (unlike JS,
  where "in" iterates keys). It is the standard Agency loop.
- Functions ("def") return Result values for fallible work. Checking with
  "if (r is success(v)) { ... }" or "is failure(e)" is correct, idiomatic
  narrowing syntax that binds v/e. "try" and "catch <default>" are
  expression forms for the same thing.
- Functions can raise effects (interrupts) such as file reads, deletes, or
  LLM calls. Callers decide them with "handle { ... } with <handler>" or
  the postfix forms "with approve" / "with reject" on a call. "with
  approve" self-approves the call's effects: whether that is appropriate
  depends on what the task says about who approves — it is not inherently
  wrong or right.
- Agency has no lambdas. JavaScript array methods that take a callback
  (.map, .filter, .reduce, .sort, .find, .forEach) cannot raise an
  interrupt, so they typecheck and then crash at run time; calling one is
  an error. The Agency forms are list
  comprehensions ("[x for x in xs if ...]") and the stdlib functions map,
  filter, sortBy, reduce called with a block ("sortBy(xs) as x { ... }").
  Methods with no callback (push, includes, join, slice) are fine.
- Declarations use let/const (bare assignment without a declaration is an
  error); types are postfix ("x: number"); string interpolation is
  "\${...}"; entry points are "node main() { ... }"; blocks always use
  braces, and if/while/for require parentheses around the condition.

Performance, robustness, and idiom suggestions (memoization, iteration
instead of deep recursion, clearer naming) are legitimate ADVISORY
feedback when they are true of this code; they are not errors.`;
