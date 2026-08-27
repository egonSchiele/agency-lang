Confirmed. `expressionToString` drops the quotes on string arguments, so `format("x")` and `format(x)` print the same. The displayed target uses the same renderer, so a literal argument could be rewritten into a variable reference and still pass the comparison.

Fixed in 17fcd4fc3: `generateExpression` now prints both the stored list and the display. Test added.
