// Every judge prompt the writing-review graders use, as plain typed
// functions: read them as prose, and a missing field is a type error.
//
// Each is a { standard, context } pair for the bundled rubric judge
// (ctx.judges.rubric): the standard is what the findings must meet, the
// context is what the judge needs to check them. Nothing here is an
// answer key; the judge is told so.

type Rubric = { standard: string; context: string };

const reviewed = (sourceFileText: string) => `The text that was reviewed:\n\n${sourceFileText}`;

export const advisoryUseful = (p: { sourceFileText: string; assignment: string }): Rubric => ({
  standard:
    "These are the ADVISORY findings (not errors) of a readability review. Findings that are specific to this text and genuinely increase its readability raise the score. Generic writing advice that fits any text, and suggestions that are not true of this text, lower the score in proportion to how many findings are affected.",
  context: `${reviewed(p.sourceFileText)}\n\nThe task the text was written for:\n\n${p.assignment}`,
});

export const namesPlantedFlaw = (p: { reason: string }): Rubric => ({
  standard:
    "These are the findings of a readability review. Do the findings identify the problems described in the context? Do they point at the planted passages, and at what makes them hard to follow? It's okay if the wording differs, as long as the meaning is the same. Return a score in proportion to how many of the planted problems were found.",
  context: `The problems we planted: ${p.reason}`,
});

export const noInventedErrorsPlanted = (p: { sourceFileText: string; reason: string }): Rubric => ({
  standard:
    "These are the ERROR findings of a readability review. Every finding is a real obstacle for the text's reader: one of the planted problems, or something genuinely hard to follow. A finding that objects to clear prose, or to a matter of taste, is invented and lowers the score in proportion.",
  context: `The planted problems: ${p.reason}\n\n${reviewed(p.sourceFileText)}`,
});

export const coversEditorPoint = (p: { point: string; notes: string }): Rubric => ({
  standard:
    "These are the findings of a readability review. Does one of them make this point from the editor's notes, about the same passage and calling for the same kind of fix? Wording may differ, and whether the finding is marked error or advisory does not matter. A finding that quotes the right passage but prescribes the opposite fix does not count: if the editor says something should go and the finding says to expand or clarify it, the point is not made. Score 1 if a finding makes the point, 0 if none does.",
  context: `The editor's point:\n\n${p.point}\n\nThe editor's full notes, for context:\n\n${p.notes}`,
});

export const noInventedErrorsHarvested = (p: {
  sourceFileText: string;
  notes: string;
}): Rubric => ({
  standard:
    "These are the ERROR findings of a readability review. Is every finding a real obstacle for the text's reader? Does it identify something that's genuinely hard to follow? Findings like that raise the score. Findings that incorrectly flag something that is actually clear or trivial lower the score. We're also adding the editor's notes as context. Score in proportion to how many of the findings are real obstacles.",
  context: `The editor's notes on what is actually wrong:\n\n${p.notes}\n\n${reviewed(p.sourceFileText)}`,
});

export const fixLandsOnDelete = (): Rubric => ({
  standard:
    "These are the findings of a readability review. The editor's verdict on this text was to delete it entirely: it tells its readers nothing they need. The findings meet the standard when they say the text should be removed rather than reworded. Findings that only suggest rewordings score near 0.",
  context: "",
});

export const fixLands = (p: { sourceFileText: string; cleaned: string }): Rubric => ({
  standard:
    "These are the findings of a readability review, each with a suggested rewrite. We're also giving you an editor's rewrite. If a writer applied these findings, would they end up with text about as readable as the editor's own rewrite? The word choice itself can be different, you need to judge on the content. What information did the editor choose to cut? What sentences did the editor choose to simplify? Would a rewrite based on these findings make similar cuts and simplifications? Judge the findings together, as one edit, not one at a time: score high if applying all of them would make the same cuts and simplifications the editor made, and low if it would leave the main problems in place.",
  context: `${reviewed(p.sourceFileText)}\n\nThe editor's rewrite:\n\n${p.cleaned}`,
});

export const recommendsCuts = (p: { sourceFileText: string; cleaned: string }): Rubric => ({
  standard:
    "These are the findings of a readability review of the text marked 'The text that was reviewed'. The findings themselves are not the text; do not compare them with the editor's version. Compare the reviewed text with the editor's version and list what the editor removed: sentences, details, or whole sections that are absent from the editor's version, whether they carried a fact or not (a repeated statement, a flourish, an aside). (If the editor's version is empty, the editor removed everything.) A clause the editor reworded or condensed while keeping its fact was not removed; do not list it. Then check the findings: do they say that the removed material should be cut, or that it does not belong? A finding that only rewords something the editor removed does not count. Score in proportion to how much of what the editor removed the findings call to cut. If the editor removed nothing, score 1 when the findings recommend no cuts, and lower the score in proportion to the cuts they do recommend.",
  context: `${reviewed(p.sourceFileText)}\n\nThe editor's version:\n\n${p.cleaned}`,
});

export const rewritesFaithful = (p: { sourceFileText: string; assignment: string }): Rubric => ({
  standard:
    "These are the findings of a readability review, each quoting a passage and suggesting a rewrite. Do the suggested rewrites keep the facts the same as the original, or do they invent facts? A rewrite may cut or simplify freely, and it may use facts from the assignment the text was written for (the reviewer saw the assignment), but it should never add a claim or detail that neither the original nor the assignment contains. For example, if the original text is about art, a rewrite shouldn't mention that Wayne Thiebaud is the best artist, if the original didn't claim that. Also, every identifier, (like a code name, a path, a symbol like `std::notes::create`) must be the same in the rewrite as it was in the original. Lower the score in proportion to the number of rewrites that invent something or alter an identifier.",
  context: `${reviewed(p.sourceFileText)}\n\nThe assignment the text was written for:\n\n${p.assignment}`,
});
