import { str, seqR, space } from "tarsec";

// define a parser
const parser = seqR(
  str("hello"),
  space,
  str("world")
);

// then use it
console.log(parser("hello world")); // success
console.log(parser("hello there")); // failure