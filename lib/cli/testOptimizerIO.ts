import { OptimizerIO } from "./optimizerIO.js";
import { FeedbackEntry } from "./optimize.js";

/**
 * Scripted OptimizerIO for testing. Feeds pre-defined inputs, feedback,
 * and proposals instead of prompting the user or calling an LLM.
 */
export class TestOptimizerIO implements OptimizerIO {
  private inputIndex = 0;
  private feedbackIndex = 0;
  private proposalIndex = 0;

  constructor(
    private inputs: Record<string, any>[],
    private feedbacks: { score: number | null; feedback: string }[],
    private proposals: string[],
    private acceptAll: boolean = true,
  ) {}

  async getUserInput(
    _nodeName: string,
    _parameters: { name: string; typeHint?: any }[],
  ): Promise<Record<string, any>> {
    return this.inputs[this.inputIndex++] || {};
  }

  async collectFeedback(): Promise<{ score: number | null; feedback: string }> {
    return this.feedbacks[this.feedbackIndex++] || { score: null, feedback: "done" };
  }

  async proposeImprovement(
    _currentPrompt: string,
    _goal: string,
    _history: FeedbackEntry[],
  ): Promise<string> {
    return this.proposals[this.proposalIndex++] || "";
  }

  async confirmProposal(_proposed: string): Promise<boolean> {
    return this.acceptAll;
  }
}
