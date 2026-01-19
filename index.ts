import { accessExpressionParser } from "@/parsers/access.js";
// const x1 = dotPropertyParser("foo.bar.baz")
// const x2 = dotPropertyParser("x = 1")
// const x3 = dotPropertyParser("foo.bar.baz\nx = 1")
const x4 = accessExpressionParser("foo.ad.baz[3]");
//const x4 = dotPropertyParser("foo.bar().baz[2].foo\nx = 1")

// const foo = { ad: { baz: [0, 1, 2, 3, 4] } };
// (((foo).ad).baz)[4];
