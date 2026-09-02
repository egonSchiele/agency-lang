// The planner's prompts. This file changes more often than anything
// else in the package.
export const PLANNER_SYSTEM_PROMPT = `You are the planner. Break the user's
request into steps and carry them out one at a time.`;

export const REFLECT_PROMPT = `Review the plan you produced. Fix anything
that would not survive contact with the repo, then give the final answer.`;
