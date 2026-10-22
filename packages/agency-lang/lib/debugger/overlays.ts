import {
  box,
  row,
  column,
  text,
  escapeStyleTags,
  type Screen,
  type Element,
  type KeyEvent,
} from "@/tui/index.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { UIState } from "./uiState.js";
import { formatValue } from "./util.js";

/**
 * The minimal interface overlays need from the host UI.
 * Keeps overlays decoupled from DebuggerUI internals.
 */
import type { InterruptResponse } from "../runtime/interrupts.js";
import type { BranchSummary, ThreadSummary } from "../runtime/state/checkpointStore.js";
import { applyLineEdit, lineEditAction } from "../tui/lineEditor.js";
import { filterPalette, type PaletteEntry } from "./edits/palette.js";
import {
  MESSAGE_PROMPT,
  amountPrompt,
  checkGrant,
  describeGuardTrip,
  draftNote,
  guardChoices,
  guardResponse,
  parseAmount,
  type GuardChoice,
  type GuardTripData,
} from "./guardAnswer.js";

export type OverlayContext = {
  screen: Screen;
  /** The next key for the person, through the UI's one reader. */
  nextKey(): Promise<KeyEvent>;
  state: UIState;
  /** Build the top portion of the standard layout (source/threads + locals/globals/callStack). */
  buildTopRows(): Element[];
  buildStatsBar(): Element;
  commandBarContent: string;
  cleanup(): void;
};

// ---------------------------------------------------------------------------
// Rewind selector
// ---------------------------------------------------------------------------

export async function showRewindSelector(
  ctx: OverlayContext,
  checkpoints: Checkpoint[],
): Promise<number | null> {
  if (checkpoints.length === 0) {
    ctx.state.log("No checkpoints available for rewind.");
    return null;
  }

  let selectedIndex = checkpoints.length - 1;
  await ctx.state.setCheckpoint(checkpoints[selectedIndex]);

  const render = () => {
    const tree = column(
      ...ctx.buildTopRows(),
      box(
        {
          flex: 1,
          border: true,
          borderColor: "yellow",
          label: " select checkpoint (Enter=select, Esc=cancel) ",
          scrollable: true,
          scrollOffset: Math.max(0, selectedIndex - 10),
        },
        text(formatCheckpointList(checkpoints, selectedIndex)),
      ),
      ctx.buildStatsBar(),
      box({ height: 3, border: true, borderColor: "white" }, text(ctx.commandBarContent)),
    );
    ctx.screen.render(tree);
  };

  render();

  while (true) {
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return null;
    }

    switch (keyEvent.key) {
      case "up":
      case "k":
        if (selectedIndex > 0) {
          selectedIndex--;
          await ctx.state.setCheckpoint(checkpoints[selectedIndex]);
          render();
        }
        break;
      case "down":
      case "j":
        if (selectedIndex < checkpoints.length - 1) {
          selectedIndex++;
          await ctx.state.setCheckpoint(checkpoints[selectedIndex]);
          render();
        }
        break;
      case "enter":
        return checkpoints[selectedIndex].id;
      case "escape":
      case "q":
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Guard trip form
// ---------------------------------------------------------------------------

/** Ask how to answer a guard trip. First a choice: approve with more
 *  budget, remove the tripped limit, or reject. A grant then asks for the
 *  amount, refused on screen while it would leave the budget exceeded,
 *  and both approvals ask for an optional message to the model. Escape in
 *  a field goes back to the choice. */
export async function showGuardTripForm(
  ctx: OverlayContext,
  data: GuardTripData,
): Promise<InterruptResponse> {
  const choices = guardChoices(data);
  const heading = [describeGuardTrip(data), draftNote(data), ""];
  let selected = 0;

  const renderLines = (lines: string[]) => {
    ctx.screen.render(
      column(
        ...ctx.buildTopRows(),
        box(
          { flex: 1, border: true, borderColor: "yellow", label: " guard tripped " },
          text([...heading, ...lines].join("\n")),
        ),
        ctx.buildStatsBar(),
        box({ height: 3, border: true, borderColor: "white" }, text(ctx.commandBarContent)),
      ),
    );
  };

  /** One line of text typed into the form; null when escape went back. */
  const askField = async (prompt: string, above: string[]): Promise<string | null> => {
    let draft = "";
    let problem: string | null = null;
    while (true) {
      renderLines([...above, `${prompt} > ${draft}_`, ...(problem ? [problem] : [])]);
      const action = lineEditAction(await ctx.nextKey());
      if (!action) continue;
      if (action.kind === "cancel") return null;
      if (action.kind === "submit") {
        if (prompt !== MESSAGE_PROMPT) {
          problem = amountProblem(data, draft);
          if (problem) {
            // Start the field over, with what was refused in the reason.
            problem = `Not "${draft}": ${problem}`;
            draft = "";
            continue;
          }
        }
        return draft;
      }
      draft = applyLineEdit(draft, action);
    }
  };

  while (true) {
    renderLines(choices.map((c, i) => `${i === selected ? ">" : " "} ${c.label}`));
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return { type: "reject" };
    }
    if ((keyEvent.key === "up" || keyEvent.key === "k") && selected > 0) selected--;
    if ((keyEvent.key === "down" || keyEvent.key === "j") && selected < choices.length - 1) {
      selected++;
    }
    if (keyEvent.key !== "enter") continue;

    const choice: GuardChoice = choices[selected].choice;
    if (choice === "reject") return guardResponse(data, choice, null, "");
    const chosen = [`> ${choices[selected].label}`];
    let amount: number | null = null;
    if (choice === "grant") {
      const typed = await askField(amountPrompt(data), chosen);
      if (typed === null) continue;
      amount = parseAmount(data.dimension, typed);
      chosen.push(`${amountPrompt(data)} > ${typed}`);
    }
    const message = await askField(MESSAGE_PROMPT, chosen);
    if (message === null) continue;
    return guardResponse(data, choice, amount, message);
  }
}

/** Why the typed amount cannot be granted, or null when it can. */
function amountProblem(data: GuardTripData, typed: string): string | null {
  const amount = parseAmount(data.dimension, typed);
  if (amount === null) {
    return data.dimension === "cost"
      ? "Type an amount in dollars, such as 0.5"
      : "Type a duration, such as 30s, 2m, or 500 for milliseconds";
  }
  return checkGrant(data, amount);
}

// ---------------------------------------------------------------------------
// Branch picker
// ---------------------------------------------------------------------------

/** Pick a branch to look at: the stopped frame's own stack first, then
 *  every branch with its status and owner. Returns the branch path, an
 *  empty path for the stopped frame, or null on escape. */
export async function showBranchPicker(
  ctx: OverlayContext,
  branches: BranchSummary[],
): Promise<string[] | null> {
  // A finished branch has no frames to look at, so its line cannot be
  // chosen: the cursor moves over the others.
  const entries: { path: string[] | null; line: string }[] = [
    { path: [], line: "the stopped frame" },
    ...branches.map((branch) => ({
      path: branch.status === "done" ? null : branch.path,
      line: `${"  ".repeat(branch.path.length - 1)}${branch.label} [${branch.status}] under ${branch.owner}`,
    })),
  ];
  const choosable = entries.map((entry, i) => i).filter((i) => entries[i].path !== null);
  let at = 0;
  const render = () =>
    ctx.screen.render(
      column(
        ...ctx.buildTopRows(),
        box(
          {
            flex: 1,
            border: true,
            borderColor: "yellow",
            label: " branches (Enter=view, Esc=cancel) ",
          },
          text(
            entries
              .map((entry, i) => `${i === choosable[at] ? ">" : " "} ${entry.line}`)
              .join("\n"),
          ),
        ),
        ctx.buildStatsBar(),
        box({ height: 3, border: true, borderColor: "white" }, text(ctx.commandBarContent)),
      ),
    );
  while (true) {
    render();
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return null;
    }
    if ((keyEvent.key === "up" || keyEvent.key === "k") && at > 0) at--;
    if ((keyEvent.key === "down" || keyEvent.key === "j") && at < choosable.length - 1) at++;
    if (keyEvent.key === "enter") return entries[choosable[at]].path;
    if (keyEvent.key === "escape" || keyEvent.key === "q") return null;
  }
}

// ---------------------------------------------------------------------------
// Checkpoints panel
// ---------------------------------------------------------------------------

const CHECKPOINTS_HELP_KEYS: Record<string, string> = {
  "↑/↓": "navigate",
  "^F/^B": "scroll detail",
  t: "toggle raw",
  enter: "go to checkpoint",
  "esc/q": "close",
};
const CHECKPOINTS_HELP = Object.entries(CHECKPOINTS_HELP_KEYS)
  .map(([key, action]) => `{bold}(${key}){/bold}${action}`)
  .join("  ");

export async function showCheckpointsPanel(
  ctx: OverlayContext,
  checkpoints: Checkpoint[],
): Promise<Checkpoint | null> {
  if (checkpoints.length === 0) {
    ctx.state.log("No checkpoints available.");
    return null;
  }

  let selectedIndex = checkpoints.length - 1;
  let rawMode = false;
  let detailScrollOffset = 0;

  const render = () => {
    const cp = checkpoints[selectedIndex];
    const detailContent = rawMode
      ? escapeStyleTags(JSON.stringify(cp.toJSON(), null, 2))
      : formatCheckpointDetail(cp);

    const tree = column(
      row(
        { flex: 1 },
        box(
          {
            width: "35%",
            border: true,
            borderColor: "cyan",
            label: ` checkpoints (${selectedIndex + 1}/${checkpoints.length}) `,
            scrollable: true,
            scrollOffset: Math.max(0, selectedIndex - 10),
          },
          text(formatCheckpointListStyled(checkpoints, selectedIndex)),
        ),
        box(
          {
            flex: 1,
            border: true,
            borderColor: "green",
            label: ` checkpoint #${cp.id} detail (${rawMode ? "raw" : "formatted"}) `,
            scrollable: true,
            scrollOffset: detailScrollOffset,
          },
          text(detailContent),
        ),
      ),
      box({ height: 3, border: true, borderColor: "white" }, text(CHECKPOINTS_HELP)),
    );
    ctx.screen.render(tree);
  };

  render();

  while (true) {
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return null;
    }

    switch (keyEvent.key) {
      case "up":
      case "k":
        if (selectedIndex > 0) {
          selectedIndex--;
          detailScrollOffset = 0;
          render();
        }
        break;
      case "down":
      case "j":
        if (selectedIndex < checkpoints.length - 1) {
          selectedIndex++;
          detailScrollOffset = 0;
          render();
        }
        break;
      case "f":
        if (keyEvent.ctrl) {
          detailScrollOffset += 20;
          render();
        }
        break;
      case "b":
        if (keyEvent.ctrl) {
          detailScrollOffset = Math.max(0, detailScrollOffset - 20);
          render();
        }
        break;
      case "t":
        rawMode = !rawMode;
        detailScrollOffset = 0;
        render();
        break;
      case "enter":
        return checkpoints[selectedIndex];
      case "escape":
      case "q":
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint formatting helpers
// ---------------------------------------------------------------------------

function formatCheckpointList(checkpoints: Checkpoint[], selectedIndex: number): string {
  return checkpoints
    .map((cp, i) => {
      const tag = checkpointTag(cp);
      const line = `${tag} #${cp.id} - ${cp.getFilename()}:${cp.scopeName} step ${cp.stepPath}${rewindNote(cp)}`;
      return i === selectedIndex
        ? `{blue-bg}{white-fg} > ${escapeStyleTags(line)} {/white-fg}{/blue-bg}`
        : `   ${escapeStyleTags(line)}`;
    })
    .join("\n");
}

function formatCheckpointListStyled(checkpoints: Checkpoint[], selectedIndex: number): string {
  return checkpoints
    .map((cp, i) => {
      let tag = "{gray-fg}[auto]{/gray-fg}";
      if (cp.pinned) {
        tag = cp.label
          ? `{yellow-fg}[manual: ${escapeStyleTags(cp.label)}]{/yellow-fg}`
          : "{magenta-fg}[code]{/magenta-fg}";
      }
      const name = `${escapeStyleTags(cp.getFilename())}:${escapeStyleTags(cp.scopeName)}`;
      const line = `${tag} {bold}#${cp.id}{/bold} ${name}${escapeStyleTags(rewindNote(cp))}`;
      return i === selectedIndex
        ? `{blue-bg}{white-fg} > ${line} {/white-fg}{/blue-bg}`
        : `   ${line}`;
    })
    .join("\n");
}

/** A checkpoint taken at the tool loop's stop before a model request
 *  replays that request when rewound to, which costs a model call. */
function rewindNote(cp: Checkpoint): string {
  return cp.loopStop === "round" ? " (replays a model request)" : "";
}

function checkpointTag(cp: Checkpoint): string {
  if (!cp.pinned) return "[auto]";
  return cp.label ? `[manual: ${cp.label}]` : "[code]";
}

function formatCheckpointDetail(cp: Checkpoint): string {
  const fmt = escapeStyleTags;
  const lines: string[] = [
    `{bold}{cyan-fg}Checkpoint #${cp.id}{/cyan-fg}{/bold}`,
    "",
    `{bold}Location:{/bold}  ${fmt(cp.getFilename())}:${fmt(cp.scopeName)}`,
    `{bold}Step:{/bold}      ${fmt(cp.stepPath)}`,
    `{bold}Node:{/bold}      ${fmt(cp.nodeId || "(none)")}`,
    `{bold}Pinned:{/bold}    ${cp.pinned ? "yes" : "no"}`,
  ];
  if (cp.label) {
    lines.push(`{bold}Label:{/bold}     ${fmt(cp.label)}`);
  }

  const frame = cp.getCurrentFrame();
  if (frame) {
    lines.push(...formatKeyValueSection("yellow", "Arguments", frame.args));
    lines.push(...formatKeyValueSection("yellow", "Locals", frame.locals));
  }

  const globals = cp.getGlobalsForModule();
  if (globals) {
    lines.push(...formatKeyValueSection("green", "Globals", globals));
  }

  const frames = cp.stack?.stack;
  if (frames && frames.length > 0) {
    lines.push(
      "",
      `{bold}{magenta-fg}Call Stack:{/magenta-fg}{/bold} (${frames.length} frame${frames.length === 1 ? "" : "s"})`,
    );
    for (let i = 0; i < frames.length; i++) {
      const entry = frames[i];
      const prefix = i === frames.length - 1 ? " > " : "   ";
      const argKeys = Object.keys(entry.args).filter((k) => !k.startsWith("__"));
      const argStr = argKeys.length > 0 ? `(${argKeys.join(", ")})` : "()";
      lines.push(`${prefix}frame ${i} ${argStr} at step ${entry.step}`);
    }
  }

  return lines.join("\n");
}

function formatKeyValueSection(
  color: string,
  title: string,
  obj: Record<string, unknown> | undefined,
): string[] {
  const fmt = escapeStyleTags;
  const entries = obj ? Object.entries(obj).filter(([k]) => !k.startsWith("__")) : [];
  const lines = ["", `{bold}{${color}-fg}${title}:{/${color}-fg}{/bold}`];
  if (entries.length > 0) {
    for (const [key, value] of entries) {
      lines.push(`  ${fmt(key)} = ${fmt(formatValue(value))}`);
    }
  } else {
    lines.push("  (none)");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Thread picker
// ---------------------------------------------------------------------------

/** Pick the thread the threads pane shows: every thread of the store, by
 *  label or id, with its parent, its message count, and a mark on the
 *  one the program is in. Returns the chosen id, or null on escape. */
export async function showThreadPicker(
  ctx: OverlayContext,
  threads: ThreadSummary[],
  shownId: string | undefined,
): Promise<string | null> {
  let selected = Math.max(
    0,
    threads.findIndex((thread) => thread.id === shownId),
  );
  const byId: Record<string, ThreadSummary> = {};
  for (const thread of threads) byId[thread.id] = thread;
  const nameOf = (thread: ThreadSummary) => thread.label ?? `id: ${thread.id}`;
  const lines = () =>
    threads.map((thread, i) => {
      const parent = thread.parentId ? byId[thread.parentId] : undefined;
      const under = parent ? ` under ${nameOf(parent)}` : "";
      const count = `${thread.messageCount} message${thread.messageCount === 1 ? "" : "s"}`;
      return `${i === selected ? ">" : " "} ${thread.active ? "*" : " "} ${nameOf(thread)} (${count}${under})${thread.hidden ? " hidden" : ""}`;
    });
  const render = () =>
    ctx.screen.render(
      column(
        ...ctx.buildTopRows(),
        box(
          {
            flex: 1,
            border: true,
            borderColor: "yellow",
            label: " threads (* = active; Enter=show, Esc=cancel) ",
          },
          text(lines().join("\n")),
        ),
        ctx.buildStatsBar(),
        box({ height: 3, border: true, borderColor: "white" }, text(ctx.commandBarContent)),
      ),
    );

  while (true) {
    render();
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return null;
    }
    if ((keyEvent.key === "up" || keyEvent.key === "k") && selected > 0) selected--;
    if ((keyEvent.key === "down" || keyEvent.key === "j") && selected < threads.length - 1) {
      selected++;
    }
    if (keyEvent.key === "enter") return threads[selected].id;
    if (keyEvent.key === "escape" || keyEvent.key === "q") return null;
  }
}

// ---------------------------------------------------------------------------
// Edit palette
// ---------------------------------------------------------------------------

/** A line to type a filter into over the edits every row offers, as the
 *  action table words them: `↑`/`↓` pick, Enter takes the entry, Escape
 *  cancels. The caller moves to the row and runs the action. */
export async function showPalette(
  ctx: OverlayContext,
  entries: PaletteEntry[],
): Promise<PaletteEntry | null> {
  let query = "";
  let selected = 0;
  const shown = () => filterPalette(entries, query);
  const lines = (matching: PaletteEntry[]) =>
    matching.length === 0
      ? ["  (no edit matches)"]
      : matching.map(
          (entry, i) => `${i === selected ? ">" : " "} ${escapeStyleTags(entry.sentence)}`,
        );
  const render = (matching: PaletteEntry[]) =>
    ctx.screen.render(
      column(
        ...ctx.buildTopRows(),
        box(
          {
            flex: 1,
            border: true,
            borderColor: "yellow",
            label: " edits (type to filter; Enter=do it, Esc=cancel) ",
          },
          text([`> ${escapeStyleTags(query)}\u2588`, ...lines(matching)].join("\n")),
        ),
        ctx.buildStatsBar(),
        box({ height: 3, border: true, borderColor: "white" }, text(ctx.commandBarContent)),
      ),
    );

  while (true) {
    const matching = shown();
    selected = Math.max(0, Math.min(selected, matching.length - 1));
    render(matching);
    const keyEvent = await ctx.nextKey();
    if (keyEvent.key === "c" && keyEvent.ctrl) {
      ctx.cleanup();
      return null;
    }
    if (keyEvent.key === "up" && selected > 0) selected--;
    if (keyEvent.key === "down" && selected < matching.length - 1) selected++;
    if (keyEvent.key === "enter") return matching[selected] ?? null;
    if (keyEvent.key === "escape") return null;
    const edit = lineEditAction(keyEvent);
    if (edit !== null) {
      query = applyLineEdit(query, edit);
      selected = 0;
    }
  }
}
