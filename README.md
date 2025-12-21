# Log Stream TUI (OpenTUI)

Streams log lines from multiple files in a folder and merges them in chronological order based on the log timestamp.

## Requirements

- [Bun](https://bun.sh)
- [Zig](https://ziglang.org) (required by OpenTUI native modules)

## Setup

```bash
bun install
```

## Run

```bash
bun run src/index.ts --dir /path/to/logs
```

## Startup Selection

On launch, you will see a file list. Click (or use `↑/↓` + `space`) to select files. Press `Enter` or click `Start` to begin streaming.

### Options

- `--dir` (default: `.`): Folder to scan for log files
- `--include` (default: `.*\\.log$`): Filename regex filter
- `--ts-regex` (default: ISO-8601 matcher): Regex with a capture group for the timestamp
- `--ts-flags` (default: empty): Regex flags
- `--delay-ms` (default: `100`): Buffer delay before emitting events
- `--inactive-ms` (default: `500`): Treat files as inactive after this idle time
- `--idle-flush-ms` (default: `500`): Flush remaining buffered lines after idle time
- `--max-lines` (default: `2000`): Max lines kept in the viewport
- `--start-at` (default: `beginning`): `beginning` or `end`

## Key Bindings

- `q`: quit
- `Enter`: start streaming (selection screen)
- `space`: toggle file selection (selection screen)
- `p` or `space`: pause/resume
- `f`: follow (jump to bottom)
- `c`: clear the viewport
- `↑/↓` or `j/k`: scroll one line
- `PgUp/PgDn`: scroll by page
- `Home/End`: jump to top/bottom
- highlighted line shows the current cursor position
- log pane is borderless to avoid copying UI border characters

## Log Colors

Each log source (file name) is assigned a distinct color for quick identification.
