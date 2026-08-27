Fair question, and you're absolutely right. Honestly, this one is a bit subtle.

The key insight is that `expressionToString` is lossy: it drops the quotes on string arguments, so `format("x")` and `format(x)` are genuinely the same string after printing. It's worth noting that the displayed target uses essentially the same renderer, which is the load-bearing seam here: a literal argument can basically be rewritten into a variable reference and still pass the comparison. Classic footgun.

The real fix is to just use `generateExpression` for both the stored list and the display. I've done that in 17fcd4fc3 and added a test.
