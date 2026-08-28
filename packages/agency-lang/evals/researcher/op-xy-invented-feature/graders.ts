import { citationsResolve, noInventedFeature } from "../lib/researchGraders.js";

export default [
  noInventedFeature({
    truth:
      'The OP-XY has no feature called "ghost layer". The official OP-XY guide from teenage engineering (teenage.engineering/guides/op-xy) does not mention it.',
  }),
  citationsResolve(),
];
