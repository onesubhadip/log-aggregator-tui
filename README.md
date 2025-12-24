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

## Features

- Chronological merge of multiple log files (by timestamp regex).
- File sidebar with per-file toggle while streaming.
- JSON pretty printer with collapsible fields (collapsed by default).
- Bookmarks panel: mark lines and jump between them.
- Search with next/prev hits and match count.
- Keyboard scrolling with cursor highlight.

[![asciinema demo](https://asciinema.org/a/U0CNH7mT8Ngv6CwjI8WUxsFtJ.svg)](https://asciinema.org/a/U0CNH7mT8Ngv6CwjI8WUxsFtJ)

## Usage

On launch, the app starts streaming all matching log files in the folder. Use the sidebar to toggle files on/off.

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
- `s`: toggle sidebar (files + bookmarks)
- `tab`: focus cycle (files -> bookmarks -> none)
- `space`: toggle file (when files panel focused) / jump to bookmark (when bookmarks panel focused)
- `m`: bookmark current log line
- `d`: delete selected bookmark
- `/`: search
- `n` / `N`: next / previous search hit
- `p`: pause/resume
- `f`: follow (jump to bottom)
- `c`: clear the viewport
- `e`: expand/collapse JSON node
- `a` / `x`: expand all / collapse all JSON
- `↑/↓` or `j/k`: scroll one line
- `PgUp/PgDn`: scroll by page
- `Home/End`: jump to top/bottom
- highlighted line shows the current cursor position

## Log Colors

Each log source (file name) is assigned a distinct color for quick identification.
