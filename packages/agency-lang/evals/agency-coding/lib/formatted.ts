// Every test carries this grader: the saved file must already be in the
// layout the Agency formatter produces. It is a small share of the score,
// enough to reward a writer that formats without outweighing correctness.
import { binary, formatSource, grader, type Grader } from "agency-lang/eval";

type CodingInput = { assignment: string; outFile: string };

export function formatted(): Grader<CodingInput> {
  return grader<CodingInput>(
    ({ workdirFile, test }) => {
      const outFile = test.input?.outFile ?? "";
      const source = workdirFile(outFile);
      if (source === "") {
        return binary(false, `no ${outFile} was saved`);
      }
      const canonical = formatSource(source);
      if (canonical === null) {
        return binary(false, `${outFile} does not parse, so it cannot be formatted`);
      }
      if (canonical === source) {
        return binary(true, `${outFile} is in the formatter's layout`);
      }
      return binary(false, `${outFile} is not formatted; running the formatter would change it`);
    },
    { name: "formatted", weight: 0.2 },
  );
}
