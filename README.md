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
- `p` or `space`: pause/resume
- `f`: follow (jump to bottom)
- `c`: clear the viewport
