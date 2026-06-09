export type EvalRunTask = {
  task_id: string;
  rubric: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
};

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

export type EvalRunDependencies = {
  runTask(args: {
    compiled: EvalRunCompiledAgent;
    node: string;
    args: Record<string, any>;
    cwd: string;
    statelogPath: string;
  }): Promise<{ ok: true } | { ok: false; errorMessage: string }>;
  extract(args: {
    statelogPath: string;
    outPath: string;
    task: EvalRunTask;
  }): Promise<void>;
  now(): Date;
};
