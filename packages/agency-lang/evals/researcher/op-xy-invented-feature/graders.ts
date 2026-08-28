import { citationsResolve, noInventedFeature } from "../lib/researchGraders.js";

export default [
  noInventedFeature({
    truth:
      'The OP-XY has no feature called "ghost layer". The name was invented for this test. Teenage engineering\'s OP-XY guide (teenage.engineering/guides/op-xy) does not mention it.',
  }),
  citationsResolve(),
];
