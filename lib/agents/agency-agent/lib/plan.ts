export type Plan = {
  overallGoal: string;
  desiredActions: string[];
};

export class Planner {
  private plans: Plan[] = [];
  private currentPlanIndex: number = -1;

  newPlan(): Plan {
    const newPlan: Plan = { overallGoal: "", desiredActions: [] };
    this.plans.push(newPlan);
    this.currentPlanIndex = this.plans.length - 1;
    return newPlan;
  }

  getCurrentPlan(): Plan | null {
    if (this.currentPlanIndex === -1) {
      return null;
    }
    return this.plans[this.currentPlanIndex];
  }

  listPlans(): Plan[] {
    return this.plans;
  }

  updateCurrentPlan(
    overallGoal: string,
    desiredActions: string[],
  ): Plan | null {
    if (this.currentPlanIndex === -1) {
      return null;
    }
    const updatedPlan: Plan = { overallGoal, desiredActions };
    this.plans[this.currentPlanIndex] = updatedPlan;
    return updatedPlan;
  }

  updateGoal(overallGoal: string): Plan | null {
    if (this.currentPlanIndex === -1) {
      return null;
    }
    const currentPlan = this.plans[this.currentPlanIndex];
    const updatedPlan: Plan = {
      overallGoal,
      desiredActions: currentPlan.desiredActions,
    };
    this.plans[this.currentPlanIndex] = updatedPlan;
    return updatedPlan;
  }

  updateActions(desiredActions: string[]): Plan | null {
    if (this.currentPlanIndex === -1) {
      return null;
    }
    const currentPlan = this.plans[this.currentPlanIndex];
    const updatedPlan: Plan = {
      overallGoal: currentPlan.overallGoal,
      desiredActions,
    };
    this.plans[this.currentPlanIndex] = updatedPlan;
    return updatedPlan;
  }
}

export const planner = new Planner();
