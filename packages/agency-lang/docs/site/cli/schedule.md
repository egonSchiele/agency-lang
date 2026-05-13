# Scheduling agents

You can schedule an Agency file to run on a recurring basis using `agency schedule`. This is useful for running an agent every morning, every hour, on weekdays only, and so on.

## Adding a schedule

```
agency schedule add foo.agency --every daily
agency schedule add foo.agency --cron "0 9 * * 1-5"
```

You can either pick a preset with `--every` or write your own cron expression with `--cron`. Exactly one of the two is required.

### Options

- `--every <preset>` — one of: `minute`, `hourly`, `daily`, `weekdays`, `weekends`, `weekly`, `monthly`.
- `--cron <expression>` — a standard 5-field cron expression.
- `--name <name>` — name for the schedule. Defaults to being derived from the filename.
- `--env-file <path>` — path to a `.env` file. Environment variables in this file are loaded into the agent's environment when it runs.

## Listing schedules

```
agency schedule list
agency schedule ls
```

## Removing a schedule

```
agency schedule remove my-agent
agency schedule rm my-agent
```

## Editing a schedule

```
agency schedule edit my-agent --every hourly
agency schedule edit my-agent --cron "0 * * * *"
```

Accepts the same `--every`, `--cron`, and `--env-file` options as `schedule add`.

## Testing the scheduler

```
agency schedule test
```

Schedules a small test agent that runs every minute. Use this to verify that cron is working on your machine.
