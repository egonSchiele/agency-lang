import { idiomGraders } from "../lib/reviewGraders.js";

export default idiomGraders({
  reason:
    'the two tool variants are hand-written wrapper functions; the Agency form is partial application of the one function, `listDir.partial(dir: "./inbox").rename("listInbox").describe("...")`, which keeps one implementation and lets the runtime enforce the fixed directory.',
});
