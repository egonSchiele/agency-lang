# Agency Schedule CLI — Design Spec

## Summary

Add `agency schedule` subcommands to the CLI that let users run Agency agents on a recurring schedule using OS-native scheduling backends: launchd (macOS), systemd timers (Linux), and crontab (Linux fallback).

## CLI Interface

### Commands

```
agency schedule add <file> --every <preset> [--name <name>] [--env-file <path>] [--command <cmd>]
agency schedule add <file> --cron "<expression>" [--name <name>] [--env-file <path>] [--command <cmd>]
agency schedule edit <name> [--every <preset>] [--cron "<expression>"] [--env-file <path>] [--command <cmd>]
agency schedule list
agency schedule remove <name>
```

### Presets

| Preset     | Cron expression | Description         |
|------------|-----------------|---------------------|
| `hourly`   | `0 * * * *`     | Top of every hour   |
| `daily`    | `0 9 * * *`     | 9am local, every day|
| `weekdays` | `0 9 * * 1-5`   | 9am local, Mon–Fri  |
| `weekly`   | `0 9 * * 1`     | 9am local, Monday   |

### Options

- **`--name <name>`**: Override the schedule name. Default: derived from filename (`morning-briefing.agency` → `morning-briefing`). If a schedule with the name already exists, prompt user to confirm overwrite (error in non-interactive/no-TTY mode).
- **`--env-file <path>`**: Path to a `.env` file to load at run time. If omitted, the agent relies on a `.env` file in its own directory (Agency's existing `loadEnv` behavior).
- **`--command <cmd>`**: Custom command to invoke Agency. Default: `"agency"`. Useful for local installs: `--command "pnpm run agency"`, `--command "npx agency-lang"`. The scheduled run executes `<command> run <agentFile>`.
- **`--every <preset>`**: Use a named preset (see table above). Mutually exclusive with `--cron`.
- **`--cron "<expression>"`**: A 5-field cron expression. Mutually exclusive with `--every`. If invalid, show: `Invalid cron expression "<expr>". Expected 5 fields: minute hour day-of-month month day-of-week. Example: "0 9 * * 1-5" (weekdays at 9am)`.

### `agency schedule edit <name>`

Accepts the same flags as `add` except `--name` (renaming is not supported; remove and re-add instead). Merges provided flags into the existing entry, leaving unspecified fields unchanged. Implementation: read entry from registry, merge flags, uninstall old OS backend config, reinstall with updated entry, write back to registry.

### `agency schedule list` Output

```
Name                Agent                          Schedule        Next Run
morning-briefing    ./morning-briefing.agency      weekdays 9am    Wed May 6 09:00
health-check        ./health-check.agency          0 */2 * * *     Wed May 6 12:00
```

- Agent column: path relative to cwd when possible, absolute otherwise.
- Schedule column: preset name if used, raw cron expression otherwise.
- Next Run column: next scheduled execution time computed from cron expression.
- If an entry's agent file is missing, show it with a `[broken]` marker.

## Registry and File Layout

### Registry

`~/.agency/schedules/schedules.json`:

```json
{
  "morning-briefing": {
    "name": "morning-briefing",
    "agentFile": "/absolute/path/to/morning-briefing.agency",
    "cron": "0 9 * * 1-5",
    "preset": "weekdays",
    "envFile": "/absolute/path/to/.env",
    "command": "agency",
    "logDir": "/Users/me/.agency/schedules/morning-briefing/logs",
    "createdAt": "2026-05-06T10:00:00-07:00",
    "backend": "launchd"
  }
}
```

All paths are stored as absolutes to avoid ambiguity when the OS triggers the run.

### Logs

`~/.agency/schedules/<name>/logs/`. Each run produces a timestamped log file: `2026-05-06T09-00-00.log` containing merged stdout/stderr. The last 50 log files per schedule are kept; older ones are deleted on each new run.

### Working Directory

The scheduled command `cd`s to the directory containing the agent file before running. This ensures relative imports and local `.env` files work correctly.

## Backend Abstraction

### Interface

```typescript
type ScheduleBackend = {
  install(entry: ScheduleEntry): void;
  uninstall(name: string): void;
}
```

### Backend Selection (automatic)

1. macOS (`process.platform === "darwin"`) → `LaunchdBackend`
2. Linux with systemd (`systemctl` binary exists) → `SystemdBackend`
3. Linux without systemd → `CrontabBackend`

### LaunchdBackend

- **install**: Writes a plist to `~/Library/LaunchAgents/com.agency.schedule.<name>.plist`, runs `launchctl load <plist>`. Plist sets `StandardOutPath`/`StandardErrorPath` to the log directory and `WorkingDirectory` to the agent's directory.
- **uninstall**: Runs `launchctl unload <plist>`, deletes the plist file.

### SystemdBackend

- **install**: Writes a `.service` and `.timer` unit to `~/.config/systemd/user/`, runs `systemctl --user enable --now <timer>`.
- **uninstall**: Runs `systemctl --user disable --now <timer>`, deletes both unit files.

### CrontabBackend

- **install**: Reads current crontab via `crontab -l`, appends a line with a comment marker (`# agency:<name>`), writes back via `crontab -`.
- **uninstall**: Reads crontab, removes the line matching `# agency:<name>`, writes back.
- Cron line invokes a wrapper script (`~/.agency/schedules/<name>/run.sh`) that creates a timestamped log file and runs the agent. This ensures consistent per-run log files across all backends.

## Module Structure

- **`lib/cli/schedule/index.ts`** — Main module: add, list, remove, edit functions. Registry read/write, log rotation, argument validation, preset-to-cron mapping.
- **`lib/cli/schedule/backends.ts`** — ScheduleBackend interface and three implementations (launchd, systemd, crontab). Backend auto-detection.
- **`scripts/agency.ts`** — Wire up the `schedule` subcommand with Commander.

No stdlib module — this is purely a CLI feature.

## Error Handling

### Validation on `add`

- Agent file must exist.
- `--env-file` path must exist if specified.
- Name must not already exist in registry (if it does, prompt to overwrite; error if no TTY).
- Cron expression must be valid 5-field format.

### Validation on `remove`/`edit`

- Name must exist in registry.

### Backend failures

- If `launchctl load` or `systemctl enable` fails, roll back the registry entry and surface the error.
- If `crontab -` fails, surface the error.

### Stale entries

- If the agent file has been moved or deleted, `agency schedule list` shows the entry with a `[broken]` marker.
- `agency schedule remove` still works on broken entries (cleans up OS backend and registry).

## Environment Variables

Scheduled runs use the `.env` file in the agent's directory by default (via Agency's existing `loadEnv`). Users can override with `--env-file <path>`. The env file path is stored in the registry so the scheduled command knows where to find it.

launchd and crontab run with minimal environments, so relying on `.env` files (rather than shell profile variables) is intentional and necessary.

## Out of Scope (v1)

- Overlap prevention (lock files for concurrent runs)
- `agency schedule logs <name>` command (users can read log files directly)
- Natural language schedule parsing
- Cloud deployment / remote scheduling
- Notifications on agent failure
