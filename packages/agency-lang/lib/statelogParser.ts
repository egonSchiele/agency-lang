import type { EventEnvelope } from "./statelog/wireTypes.js";
import { extractEvalRecord, type ExtractOptions } from "./eval/extract.js";
import { normalize, type Normalized } from "./eval/normalize.js";
import { readAllEventsSync } from "./eval/parseJsonl.js";
import type {
  ErrorEntry,
  EvalRecord,
  EvalValue,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  ThreadEntry,
} from "./eval/types.js";

export type StatelogParserOptions = ExtractOptions;

export class StatelogParser {
  private eventsCache?: EventEnvelope[];
  private normalizedCache?: Normalized;
  private evalRecordCache?: EvalRecord;

  constructor(
    private readonly filePath: string,
    private readonly options: StatelogParserOptions = {},
  ) {}

  events(): EventEnvelope[] {
    if (!this.eventsCache) {
      this.eventsCache = readAllEventsSync(this.filePath);
    }
    return this.eventsCache;
  }

  normalized(): Normalized {
    if (!this.normalizedCache) {
      assertSingleTrace(this.events());
      this.normalizedCache = normalize(this.events());
    }
    return this.normalizedCache;
  }

  evalRecord(): EvalRecord {
    if (!this.evalRecordCache) {
      assertSingleTrace(this.events());
      this.evalRecordCache = extractEvalRecord(
        this.events(),
        this.filePath,
        this.options,
      );
    }
    return this.evalRecordCache;
  }

  evalInputs(): EvalValue[] {
    return this.evalRecord().evalInputs;
  }

  evalOutputs(): EvalValue[] {
    return this.evalRecord().evalOutputs;
  }

  finalEvalOutput(): EvalValue | null {
    return this.evalOutputs().at(-1) ?? null;
  }

  threads(): ThreadEntry[] {
    return this.evalRecord().threads;
  }

  normalizedEvents(): NormalizedEvent[] {
    return this.evalRecord().events;
  }

  interrupts(): InterruptEntry[] {
    return this.evalRecord().interrupts;
  }

  errors(): ErrorEntry[] {
    return this.evalRecord().errors;
  }

  incompleteInvocations(): IncompleteInvocation[] {
    return this.evalRecord().incomplete;
  }

  metrics(): Metrics {
    return this.evalRecord().metrics;
  }

  warnings(): string[] {
    return this.evalRecord().warnings;
  }
}

function assertSingleTrace(events: EventEnvelope[]): void {
  const traceIds: Record<string, true> = {};
  for (const event of events) {
    traceIds[event.trace_id] = true;
  }
  const ids = Object.keys(traceIds);
  if (ids.length > 1) {
    throw new Error(
      `extract: multiple trace_ids in input (${ids.join(", ")}). Exactly one trace per file is supported.`,
    );
  }
}
