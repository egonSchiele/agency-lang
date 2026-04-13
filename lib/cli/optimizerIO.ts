import { AgencyConfig } from "@/config.js";
import * as smoltalk from "smoltalk";
import prompts from "prompts";
import { FeedbackEntry } from "./optimize.js";

// ---------------------------------------------------------------------------
// OptimizerIO — interface for all user and LLM interactions
// ---------------------------------------------------------------------------

export type OptimizerIO = {
  getUserInput(nodeName: string, parameters: { name: string; typeHint?: any }[]): Promise<Record<string, any>>;
  collectFeedback(): Promise<{ score: number | null; feedback: string }>;
  proposeImprovement(currentPrompt: string, goal: string, history: FeedbackEntry[]): Promise<string>;
  confirmProposal(proposed: string): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// DefaultOptimizerIO — real interactive IO using prompts + smoltalk
// ---------------------------------------------------------------------------

export class DefaultOptimizerIO implements OptimizerIO {
  constructor(private config: AgencyConfig) {}

  async getUserInput(
    nodeName: string,
    parameters: { name: string; typeHint?: any }[],
  ): Promise<Record<string, any>> {
    console.log(`Provide input for node "${nodeName}":`);
    const args: Record<string, any> = {};
    for (const param of parameters) {
      const typeLabel = param.typeHint ? ` (${JSON.stringify(param.typeHint)})` : "";
      const response = await prompts({
        type: "text",
        name: "value",
        message: `${param.name}${typeLabel}:`,
      });
      if (response.value === undefined) process.exit(0);
      try {
        args[param.name] = JSON.parse(response.value);
      } catch {
        args[param.name] = response.value;
      }
    }
    return args;
  }

  async collectFeedback(): Promise<{ score: number | null; feedback: string }> {
    const response = await prompts({
      type: "text",
      name: "feedback",
      message: "Score (1-10) and/or feedback (or 'done' to finish):",
    });
    if (!response.feedback || response.feedback.toLowerCase() === "done") {
      return { score: null, feedback: "done" };
    }
    const match = response.feedback.match(/^(\d+)\s*[,.]?\s*(.*)/);
    if (match) {
      return { score: parseInt(match[1], 10), feedback: match[2] || "" };
    }
    return { score: null, feedback: response.feedback };
  }

  async proposeImprovement(
    currentPrompt: string,
    goal: string,
    history: FeedbackEntry[],
  ): Promise<string> {
    const historyText = history.map((entry, i) => {
      const scoreText = entry.score !== null ? `Score: ${entry.score}/10` : "No score";
      return `--- Attempt ${i + 1} ---\nPrompt: "${entry.promptUsed}"\nInput: ${JSON.stringify(entry.input)}\nOutput: ${JSON.stringify(entry.output)}\n${scoreText}\nFeedback: ${entry.feedback || "none"}`;
    }).join("\n\n");

    const optimizerPrompt = `You are a prompt optimization assistant. Your job is to improve an LLM prompt based on user feedback.

GOAL: ${goal}

CURRENT PROMPT: "${currentPrompt}"

HISTORY OF ATTEMPTS AND FEEDBACK:
${historyText}

Based on the feedback, propose an improved version of the prompt. The prompt may contain template variables like \${variableName} — preserve these exactly as they are.

Respond with ONLY the improved prompt text, nothing else. Do not wrap it in quotes.`;

    const model = this.config.client?.defaultModel || "gpt-4o-mini";

    const result = await smoltalk.textSync({
      messages: [smoltalk.userMessage(optimizerPrompt)],
      model,
    });

    if (!result.success) {
      throw new Error(`Error from LLM during optimization: ${result.error}`);
    }

    return (result.value.output || "").trim();
  }

  async confirmProposal(proposed: string): Promise<boolean> {
    console.log(`\nProposed prompt:\n  "${proposed}"\n`);
    const response = await prompts({
      type: "confirm",
      name: "accept",
      message: "Accept this prompt?",
      initial: true,
    });
    return !!response.accept;
  }
}
