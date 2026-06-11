export type EvalTask = {
  task_id: string;
  goal: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
};

export type EvalRunTask = EvalTask;

export type EvalRunTaskResult = {
  taskId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string;
};

export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  tasks: EvalRunTaskResult[];
  okCount: number;
  errorCount: number;
};

export type EvalRunConfig = {
  runId: string;
  runsDir: string;
  agent: string;
  tasks: EvalRunTask[];
  tasksSource: string;
  continueOnError: boolean;
  verbose?: boolean;
};

export type EvalRunCompiledAgent = {
  moduleId: string;
  path?: string;
};
