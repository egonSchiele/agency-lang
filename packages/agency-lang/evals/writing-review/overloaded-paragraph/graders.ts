import { plantedFlawGraders } from "../lib/reviewGraders.js";

export default plantedFlawGraders({
  reason:
    'The opening sentence is a garden path ("The run directory annotations fold" reads as a ' +
    'verb phrase until "determines" arrives) and stacks several new concepts with a nested ' +
    "parenthetical before its verb, so a newcomer loses the thread. The second sentence is " +
    'passive throughout ("is taken by the reader", "is enforced by") and chains four ideas ' +
    'with commas and a "which" clause. A reader new to the codebase cannot follow this.',
});
