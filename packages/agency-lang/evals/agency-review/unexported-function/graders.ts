import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "greetAll is declared without `export`, so the other files the task says will call it cannot import it.",
});
