import {
  box,
  row,
  column,
  text,
  escapeStyleTags,
  type Screen,
  type Element,
} from "@/tui/index.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { UIState } from "./uiState.js";
import { formatValue } from "./util.js";

/**
 * The minimal interface overlays need from the host UI.
 * Keeps overlays decoupled from DebuggerUI internals.
 */
export type OverlayContext = {
  screen: Screen;
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
      box(
        { height: 3, border: true, borderColor: "white" },
        text(ctx.commandBarContent),
      ),
    );
    ctx.screen.render(tree);
  };

  render();

  while (true) {
    const keyEvent = await ctx.screen.nextKey();
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
      box(
        { height: 3, border: true, borderColor: "white" },
        text(CHECKPOINTS_HELP),
      ),
    );
    ctx.screen.render(tree);
  };

  render();

  while (true) {
    const keyEvent = await ctx.screen.nextKey();
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

function formatCheckpointList(
  checkpoints: Checkpoint[],
  selectedIndex: number,
): string {
  return checkpoints
    .map((cp, i) => {
      const tag = checkpointTag(cp);
      const line = `${tag} #${cp.id} - ${cp.getFilename()}:${cp.scopeName} step ${cp.stepPath}`;
      return i === selectedIndex
        ? `{blue-bg}{white-fg} > ${escapeStyleTags(line)} {/white-fg}{/blue-bg}`
        : `   ${escapeStyleTags(line)}`;
    })
    .join("\n");
}

function formatCheckpointListStyled(
  checkpoints: Checkpoint[],
  selectedIndex: number,
): string {
  return checkpoints
    .map((cp, i) => {
      let tag = "{gray-fg}[auto]{/gray-fg}";
      if (cp.pinned) {
        tag = cp.label
          ? `{yellow-fg}[manual: ${escapeStyleTags(cp.label)}]{/yellow-fg}`
          : "{magenta-fg}[code]{/magenta-fg}";
      }
      const name = `${escapeStyleTags(cp.getFilename())}:${escapeStyleTags(cp.scopeName)}`;
      const line = `${tag} {bold}#${cp.id}{/bold} ${name}`;
      return i === selectedIndex
        ? `{blue-bg}{white-fg} > ${line} {/white-fg}{/blue-bg}`
        : `   ${line}`;
    })
    .join("\n");
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
  const entries = obj
    ? Object.entries(obj).filter(([k]) => !k.startsWith("__"))
    : [];
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
