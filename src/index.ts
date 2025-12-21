import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  StyledText,
  createCliRenderer,
  bg,
  dim,
  fg,
  type TextChunk,
} from "@opentui/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type StartAt = "beginning" | "end";

type CliOptions = {
  dir: string;
  include: string;
  tsRegexSource: string;
  tsRegexFlags: string;
  delayMs: number;
  inactiveMs: number;
  idleFlushMs: number;
  maxLines: number;
  startAt: StartAt;
  help: boolean;
};

type LogEvent = {
  timestamp: number;
  line: string;
  source: string;
  sequence: number;
};

type LogLine = {
  timestamp: number;
  line: string;
  source: string;
};

type FileRow = {
  filePath: string;
  fileName: string;
  row: BoxRenderable;
  label: TextRenderable;
  selected: boolean;
};

type FileState = {
  filePath: string;
  displayName: string;
  position: number;
  buffer: string;
  lastParsedTimestamp?: number;
  reading: boolean;
  pendingRead: boolean;
  watcher?: fs.FSWatcher;
};

const DEFAULT_TS_REGEX =
  "(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)";

const DEFAULT_OPTIONS: CliOptions = {
  dir: ".",
  include: ".*\\.log$",
  tsRegexSource: DEFAULT_TS_REGEX,
  tsRegexFlags: "",
  delayMs: 100,
  inactiveMs: 500,
  idleFlushMs: 500,
  maxLines: 2000,
  startAt: "beginning",
  help: false,
};

const SOURCE_COLORS = [
  "#0057FF",
  "#B000FF",
  "#C77D00",
  "#008A2E",
  "#D00000",
  "#007A8C",
  "#6B00FF",
  "#8A4B00",
] as const;
const SYSTEM_COLOR = "#6B7280";
const CURSOR_BG = "#2D333B";
const ROW_CURSOR_BG = "#1F2937";
const ROW_SELECTED_BG = "#243B53";
const ROW_CURSOR_SELECTED_BG = "#2E4A6B";
const START_ENABLED_BG = "#1D4ED8";
const START_DISABLED_BG = "#374151";
const sourceColorMap = new Map<string, string>();
let nextSourceColorIndex = 0;

class MinHeap<T> {
  private items: T[] = [];
  private compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    if (this.items.length === 1) return this.items.pop();

    const root = this.items[0];
    this.items[0] = this.items.pop() as T;
    this.bubbleDown(0);
    return root;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.items[current], this.items[parent]) >= 0) {
        break;
      }
      this.swap(current, parent);
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = current * 2 + 2;
      let smallest = current;

      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
        smallest = right;
      }

      if (smallest === current) break;
      this.swap(current, smallest);
      current = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const temp = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = temp;
  }
}

class LogMerger {
  private heap = new MinHeap<LogEvent>((a, b) => {
    if (a.timestamp === b.timestamp) return a.sequence - b.sequence;
    return a.timestamp - b.timestamp;
  });
  private lastSeenTimestamp = new Map<string, number>();
  private lastLineAt = new Map<string, number>();
  private maxTimestampSeen = 0;
  private lastEventAt = 0;
  private sequence = 0;

  constructor(
    private options: { delayMs: number; inactiveMs: number; idleFlushMs: number },
    private onEvent: (event: LogEvent) => void,
  ) {}

  push(source: string, line: string, timestamp: number): void {
    const now = Date.now();
    this.lastSeenTimestamp.set(source, timestamp);
    this.lastLineAt.set(source, now);
    this.maxTimestampSeen = Math.max(this.maxTimestampSeen, timestamp);
    this.lastEventAt = now;

    this.heap.push({ timestamp, line, source, sequence: this.sequence++ });
  }

  flushReady(now: number = Date.now()): number {
    if (this.heap.size === 0) return 0;

    const activeTimestamps: number[] = [];
    for (const [source, lastAt] of this.lastLineAt.entries()) {
      if (now - lastAt <= this.options.inactiveMs) {
        const ts = this.lastSeenTimestamp.get(source);
        if (ts !== undefined) activeTimestamps.push(ts);
      }
    }

    let watermark: number;
    if (activeTimestamps.length > 0) {
      watermark = Math.min(...activeTimestamps) - this.options.delayMs;
    } else if (now - this.lastEventAt >= this.options.idleFlushMs) {
      watermark = Number.POSITIVE_INFINITY;
    } else {
      watermark = this.maxTimestampSeen - this.options.delayMs;
    }

    let flushed = 0;
    while (this.heap.size > 0) {
      const next = this.heap.peek();
      if (!next || next.timestamp > watermark) break;
      this.onEvent(this.heap.pop() as LogEvent);
      flushed += 1;
    }

    return flushed;
  }

  flushAll(): number {
    let flushed = 0;
    while (this.heap.size > 0) {
      this.onEvent(this.heap.pop() as LogEvent);
      flushed += 1;
    }
    return flushed;
  }

  get bufferSize(): number {
    return this.heap.size;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULT_OPTIONS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
      case "-d":
        options.dir = argv[i + 1] ?? options.dir;
        i += 1;
        break;
      case "--include":
      case "-i":
        options.include = argv[i + 1] ?? options.include;
        i += 1;
        break;
      case "--ts-regex":
        options.tsRegexSource = argv[i + 1] ?? options.tsRegexSource;
        i += 1;
        break;
      case "--ts-flags":
        options.tsRegexFlags = argv[i + 1] ?? options.tsRegexFlags;
        i += 1;
        break;
      case "--delay-ms":
        options.delayMs = parseNumberArg(argv[i + 1], options.delayMs);
        i += 1;
        break;
      case "--inactive-ms":
        options.inactiveMs = parseNumberArg(argv[i + 1], options.inactiveMs);
        i += 1;
        break;
      case "--idle-flush-ms":
        options.idleFlushMs = parseNumberArg(argv[i + 1], options.idleFlushMs);
        i += 1;
        break;
      case "--max-lines":
        options.maxLines = parseNumberArg(argv[i + 1], options.maxLines);
        i += 1;
        break;
      case "--start-at":
        options.startAt = ((argv[i + 1] as StartAt) ?? options.startAt).toLowerCase() as StartAt;
        i += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          options.dir = arg;
        }
        break;
    }
  }

  if (options.startAt !== "beginning" && options.startAt !== "end") {
    options.startAt = "beginning";
  }

  return options;
}

function parseNumberArg(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function printHelp(): void {
  const helpText = `Usage: bun run src/index.ts [options]

Options:
  --dir, -d <path>         Folder to scan for log files (default: .)
  --include, -i <regex>    Filename regex filter (default: .*\\.log$)
  --ts-regex <regex>       Regex with capture group for timestamp
  --ts-flags <flags>       Regex flags (default: empty)
  --delay-ms <number>      Buffer delay before emitting events (default: 500)
  --inactive-ms <number>   Treat files as inactive after idle time (default: 2000)
  --idle-flush-ms <number> Flush remaining buffer after idle time (default: 2000)
  --max-lines <number>     Max lines kept in viewport (default: 2000)
  --start-at <beginning|end>
  --help, -h               Show this help
`;
  process.stdout.write(helpText);
}

const cliOptions = parseArgs(process.argv.slice(2));
if (cliOptions.help) {
  printHelp();
  process.exit(0);
}

let includeRegex: RegExp;
let timestampRegex: RegExp;
try {
  includeRegex = new RegExp(cliOptions.include);
  timestampRegex = new RegExp(cliOptions.tsRegexSource, cliOptions.tsRegexFlags);
} catch (error) {
  console.error("Invalid regex configuration:", error);
  process.exit(1);
}

const directory = path.resolve(process.cwd(), cliOptions.dir);
const dirStat = await fs.promises.stat(directory).catch(() => null);
if (!dirStat || !dirStat.isDirectory()) {
  console.error(`Directory not found: ${directory}`);
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true });

const selectionView = new BoxRenderable(renderer, {
  position: "absolute",
  width: "100%",
  height: "100%",
  flexDirection: "column",
  padding: 1,
  gap: 1,
});

const logView = new BoxRenderable(renderer, {
  position: "absolute",
  width: "100%",
  height: "100%",
  flexDirection: "column",
  padding: 1,
  gap: 1,
  visible: false,
});

renderer.root.add(selectionView);
renderer.root.add(logView);

const selectionHeader = new BoxRenderable(renderer, {
  height: 4,
  border: true,
  title: "Select Log Files",
  paddingLeft: 1,
  paddingRight: 1,
});
const selectionHeaderText = new TextRenderable(renderer, {
  wrapMode: "none",
  attributes: TextAttributes.DIM,
  content: "",
});
selectionHeader.add(selectionHeaderText);

const selectionListPanel = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  title: "Files",
  padding: 1,
  flexDirection: "column",
  gap: 0,
});
const selectionList = new BoxRenderable(renderer, {
  flexDirection: "column",
  gap: 0,
  flexGrow: 1,
});
selectionListPanel.add(selectionList);

const selectionFooter = new BoxRenderable(renderer, {
  height: 3,
  border: true,
  title: "Actions",
  paddingLeft: 1,
  paddingRight: 1,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
});
const selectionFooterText = new TextRenderable(renderer, {
  wrapMode: "none",
  attributes: TextAttributes.DIM,
  content: "Click/space to toggle, Enter to start, q to quit",
});
const startButton = new BoxRenderable(renderer, {
  height: 1,
  paddingLeft: 2,
  paddingRight: 2,
  backgroundColor: START_DISABLED_BG,
  justifyContent: "center",
  alignItems: "center",
});
const startButtonText = new TextRenderable(renderer, {
  wrapMode: "none",
  fg: "#ffffff",
  content: "Start",
});
startButton.add(startButtonText);
startButton.onMouseDown = () => {
  void startStreaming();
};
selectionFooter.add(selectionFooterText);
selectionFooter.add(startButton);

selectionView.add(selectionHeader);
selectionView.add(selectionListPanel);
selectionView.add(selectionFooter);

const header = new BoxRenderable(renderer, {
  height: 5,
  border: true,
  title: "Log Stream",
  paddingLeft: 1,
  paddingRight: 1,
});
const headerText = new TextRenderable(renderer, {
  wrapMode: "none",
  attributes: TextAttributes.DIM,
  content: "",
});
header.add(headerText);

const logBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  overflow: "hidden",
  paddingLeft: 1,
  paddingRight: 1,
});

const logText = new TextRenderable(renderer, {
  wrapMode: "none",
  content: "",
  selectionBg: "#335577",
  selectionFg: "#ffffff",
  width: "100%",
  height: "100%",
});
logBox.add(logText);

const footer = new BoxRenderable(renderer, {
  height: 3,
  border: true,
  title: "Keys",
  paddingLeft: 1,
  paddingRight: 1,
});
const footerText = new TextRenderable(renderer, {
  wrapMode: "none",
  attributes: TextAttributes.DIM,
  content: "q quit | p/space pause | f follow | c clear | arrows/pg scroll",
});
footer.add(footerText);

logView.add(header);
logView.add(logBox);
logView.add(footer);

const fileStates = new Map<string, FileState>();
const pendingFiles = new Set<string>();
const logEntries: LogLine[] = [];
const selectedFiles = new Set<string>();
const fileRows: FileRow[] = [];
let selectionCursor = 0;
let selectionActive = true;

let paused = false;
let scheduledRender = false;
let initializing = true;
let isShuttingDown = false;
let flushTimer: NodeJS.Timeout | undefined;
let cursorIndex = 0;
let followTailEnabled = true;

const merger = new LogMerger(
  {
    delayMs: cliOptions.delayMs,
    inactiveMs: cliOptions.inactiveMs,
    idleFlushMs: cliOptions.idleFlushMs,
  },
  (event) => {
    appendEvent({ timestamp: event.timestamp, source: event.source, line: event.line });
  },
);

async function listLogFiles(): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    includeRegex.lastIndex = 0;
    if (!includeRegex.test(entry.name)) continue;
    files.push(path.join(directory, entry.name));
  }
  files.sort();
  return files;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Invalid time";
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function colorForSource(source: string): string {
  if (source === "system") return SYSTEM_COLOR;
  const existing = sourceColorMap.get(source);
  if (existing) return existing;
  const color = SOURCE_COLORS[nextSourceColorIndex % SOURCE_COLORS.length];
  nextSourceColorIndex += 1;
  sourceColorMap.set(source, color);
  return color;
}

function formatEventStyled(event: LogLine): StyledText {
  const time = formatTimestamp(event.timestamp);
  const sourceColor = colorForSource(event.source);
  const sourceLabel = `[${event.source}]`;
  return new StyledText([
    dim(time),
    { __isChunk: true, text: " ", attributes: 0 },
    fg(sourceColor)(sourceLabel),
    { __isChunk: true, text: " ", attributes: 0 },
    { __isChunk: true, text: event.line, attributes: 0 },
  ]);
}

function applyCursorHighlight(styled: StyledText): StyledText {
  const applyBg = bg(CURSOR_BG);
  return new StyledText(styled.chunks.map((chunk) => applyBg(chunk)));
}

function buildStyledLog(entries: LogLine[]): StyledText {
  if (entries.length === 0) {
    return new StyledText([{ __isChunk: true, text: "", attributes: 0 }]);
  }

  const chunks: TextChunk[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const styled = i === cursorIndex ? applyCursorHighlight(formatEventStyled(entries[i])) : formatEventStyled(entries[i]);
    chunks.push(...styled.chunks);
    if (i < entries.length - 1) {
      chunks.push({ __isChunk: true, text: "\n", attributes: 0 });
    }
  }
  return new StyledText(chunks);
}

function appendEvent(event: LogLine): void {
  logEntries.push(event);
  if (logEntries.length > cliOptions.maxLines) {
    const removed = logEntries.length - cliOptions.maxLines;
    logEntries.splice(0, removed);
    cursorIndex = Math.max(0, cursorIndex - removed);
  }
  scheduleRender();
}

function ensureCursorVisible(): void {
  const viewportHeight = Math.max(1, logText.height || 1);
  const top = logText.scrollY;
  const bottom = top + viewportHeight - 1;
  let nextTop = top;
  if (cursorIndex < top) {
    nextTop = cursorIndex;
  } else if (cursorIndex > bottom) {
    nextTop = Math.max(0, cursorIndex - viewportHeight + 1);
  }
  if (nextTop !== top) {
    logText.scrollY = nextTop;
  }
}

function setCursor(index: number): void {
  if (logEntries.length === 0) {
    cursorIndex = 0;
    return;
  }
  cursorIndex = Math.max(0, Math.min(index, logEntries.length - 1));
  ensureCursorVisible();
  scheduleRender();
}

function moveCursor(delta: number): void {
  if (logEntries.length === 0) return;
  followTailEnabled = false;
  setCursor(cursorIndex + delta);
}

function followTail(): void {
  followTailEnabled = true;
  cursorIndex = Math.max(0, logEntries.length - 1);
  logText.scrollY = logText.maxScrollY;
  scheduleRender();
}

function scheduleRender(): void {
  if (scheduledRender) return;
  scheduledRender = true;
  setTimeout(() => {
    scheduledRender = false;
    logText.content = buildStyledLog(logEntries);
    if (followTailEnabled) {
      cursorIndex = Math.max(0, logEntries.length - 1);
      logText.scrollY = logText.maxScrollY;
    }
    updateStatus();
  }, 16);
}

function updateStatus(): void {
  const statusLine = paused ? "PAUSED" : "LIVE";
  headerText.content = `Dir: ${directory}\nFiles: ${fileStates.size} (filter: ${cliOptions.include}) | Lines: ${logEntries.length}/${cliOptions.maxLines}\nDelay: ${cliOptions.delayMs}ms | Inactive: ${cliOptions.inactiveMs}ms | Idle flush: ${cliOptions.idleFlushMs}ms | ${statusLine} | Buffered: ${merger.bufferSize}`;
}

function updateSelectionHeader(): void {
  const count = selectedFiles.size;
  selectionHeaderText.content = `Dir: ${directory}\nFound: ${fileRows.length} | Selected: ${count}`;
}

function updateStartButton(): void {
  const enabled = selectedFiles.size > 0;
  startButton.backgroundColor = enabled ? START_ENABLED_BG : START_DISABLED_BG;
}

function updateSelectionRow(row: FileRow, index: number): void {
  const isCursor = index === selectionCursor;
  const isSelected = row.selected;
  row.label.content = `${isSelected ? "[x]" : "[ ]"} ${row.fileName}`;

  if (isCursor && isSelected) {
    row.row.backgroundColor = ROW_CURSOR_SELECTED_BG;
  } else if (isSelected) {
    row.row.backgroundColor = ROW_SELECTED_BG;
  } else if (isCursor) {
    row.row.backgroundColor = ROW_CURSOR_BG;
  } else {
    row.row.backgroundColor = "transparent";
  }
}

function refreshSelectionUI(): void {
  fileRows.forEach((row, index) => {
    updateSelectionRow(row, index);
  });
  updateSelectionHeader();
  updateStartButton();
}

function toggleSelection(index: number): void {
  const row = fileRows[index];
  if (!row) return;
  row.selected = !row.selected;
  if (row.selected) {
    selectedFiles.add(row.filePath);
  } else {
    selectedFiles.delete(row.filePath);
  }
  refreshSelectionUI();
}

function setSelectionCursor(index: number): void {
  if (fileRows.length === 0) {
    selectionCursor = 0;
    return;
  }
  selectionCursor = Math.max(0, Math.min(index, fileRows.length - 1));
  refreshSelectionUI();
}

async function populateSelectionList(): Promise<void> {
  const files = await listLogFiles();
  fileRows.length = 0;
  selectedFiles.clear();

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const row = new BoxRenderable(renderer, {
      height: 1,
      width: "100%",
      backgroundColor: "transparent",
    });
    const label = new TextRenderable(renderer, {
      wrapMode: "none",
      content: `[ ] ${fileName}`,
    });
    row.add(label);
    const rowEntry: FileRow = { filePath, fileName, row, label, selected: false };
    row.onMouseDown = () => {
      const index = fileRows.indexOf(rowEntry);
      if (index >= 0) {
        selectionCursor = index;
        toggleSelection(index);
      }
    };
    fileRows.push(rowEntry);
    selectionList.add(row);
  }

  selectionCursor = 0;
  refreshSelectionUI();
}

async function startStreaming(): Promise<void> {
  if (!selectionActive || selectedFiles.size === 0) return;
  selectionActive = false;
  selectionView.visible = false;
  logView.visible = true;
  renderer.useMouse = false;

  initializing = true;
  logEntries.length = 0;
  logEntries.push({ timestamp: Date.now(), source: "system", line: "Starting log stream..." });
  followTailEnabled = true;
  cursorIndex = Math.max(0, logEntries.length - 1);

  for (const filePath of selectedFiles) {
    await startWatchingFile(filePath);
  }

  merger.flushAll();
  scheduleRender();
  initializing = false;
}

function parseTimestamp(line: string, state: FileState): number {
  const match = timestampRegex.exec(line);
  timestampRegex.lastIndex = 0;
  if (match && match[1]) {
    const parsed = Date.parse(match[1]);
    if (!Number.isNaN(parsed)) {
      state.lastParsedTimestamp = parsed;
      return parsed;
    }
  }

  const fallback = state.lastParsedTimestamp ?? Date.now();
  state.lastParsedTimestamp = fallback;
  return fallback;
}

function ingestLine(state: FileState, line: string): void {
  const timestamp = parseTimestamp(line, state);
  merger.push(state.displayName, line, timestamp);
  if (!paused && !initializing) {
    merger.flushReady();
  }
}

async function readExistingLines(state: FileState): Promise<void> {
  const stream = fs.createReadStream(state.filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    ingestLine(state, line);
  }

  state.position = stream.bytesRead;
  await readNewData(state);
}

async function readNewData(state: FileState): Promise<void> {
  if (state.reading) {
    state.pendingRead = true;
    return;
  }

  state.reading = true;
  try {
    const stat = await fs.promises.stat(state.filePath);

    if (stat.size < state.position) {
      state.position = 0;
      state.buffer = "";
      state.lastParsedTimestamp = undefined;
    }

    if (stat.size === state.position) {
      return;
    }

    const stream = fs.createReadStream(state.filePath, {
      encoding: "utf8",
      start: state.position,
      end: stat.size - 1,
    });

    let chunkData = "";
    for await (const chunk of stream) {
      chunkData += chunk;
    }

    state.position = stat.size;
    if (chunkData.length === 0) return;

    state.buffer += chunkData;
    const parts = state.buffer.split(/\r?\n/);
    state.buffer = parts.pop() ?? "";

    for (const line of parts) {
      ingestLine(state, line);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      removeFile(state.filePath);
      return;
    }
    console.error(`Failed to read ${state.filePath}:`, error);
  } finally {
    state.reading = false;
    if (state.pendingRead) {
      state.pendingRead = false;
      await readNewData(state);
    }
  }
}

function removeFile(filePath: string): void {
  const state = fileStates.get(filePath);
  if (state?.watcher) {
    state.watcher.close();
  }
  fileStates.delete(filePath);
  updateStatus();
}

async function startWatchingFile(filePath: string): Promise<void> {
  if (fileStates.has(filePath) || pendingFiles.has(filePath)) return;
  pendingFiles.add(filePath);

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return;
    }

    const state: FileState = {
      filePath,
      displayName: path.basename(filePath),
      position: 0,
      buffer: "",
      reading: false,
      pendingRead: false,
    };

    fileStates.set(filePath, state);

    if (cliOptions.startAt === "beginning") {
      await readExistingLines(state);
    } else {
      state.position = stat.size;
    }

    state.watcher = fs.watch(filePath, { persistent: true }, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        void readNewData(state);
      }
    });
  } finally {
    pendingFiles.delete(filePath);
    updateStatus();
  }
}

function shutdown(exitCode: number): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  for (const state of fileStates.values()) {
    state.watcher?.close();
  }
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  renderer.destroy();
  process.exit(exitCode);
}

renderer.keyInput.on("keypress", (key) => {
  if (key.name === "q") {
    shutdown(0);
  }

  if (selectionActive) {
    const keyName = key.name?.toLowerCase();
    if (keyName === "up" || keyName === "k") {
      setSelectionCursor(selectionCursor - 1);
      return;
    }
    if (keyName === "down" || keyName === "j") {
      setSelectionCursor(selectionCursor + 1);
      return;
    }
    if (keyName === "space") {
      toggleSelection(selectionCursor);
      return;
    }
    if (keyName === "enter" || keyName === "return") {
      void startStreaming();
      return;
    }
    return;
  }

  const viewportHeight = Math.max(1, logText.height || 1);
  const pageSize = Math.max(1, viewportHeight - 1);
  const keyName = key.name?.toLowerCase();
  if (keyName === "up" || keyName === "k") {
    moveCursor(-1);
    return;
  }
  if (keyName === "down" || keyName === "j") {
    moveCursor(1);
    return;
  }
  if (keyName === "pageup" || keyName === "prior") {
    moveCursor(-pageSize);
    return;
  }
  if (keyName === "pagedown" || keyName === "next") {
    moveCursor(pageSize);
    return;
  }
  if (keyName === "home") {
    followTailEnabled = false;
    setCursor(0);
    return;
  }
  if (keyName === "end") {
    followTail();
    return;
  }

  if (key.name === "p" || key.name === "space") {
    paused = !paused;
    if (!paused) {
      merger.flushAll();
      scheduleRender();
    }
    updateStatus();
  }

  if (key.name === "f") {
    followTail();
  }

  if (key.name === "c") {
    logEntries.length = 0;
    cursorIndex = 0;
    logText.content = new StyledText([{ __isChunk: true, text: "", attributes: 0 }]);
    updateStatus();
  }
});

flushTimer = setInterval(() => {
  if (!paused && !initializing) {
    merger.flushReady();
  }
  if (!selectionActive) {
    updateStatus();
  }
}, 100);

selectionHeaderText.content = "Loading log files...";
await populateSelectionList();
initializing = false;

process.on("SIGINT", () => {
  shutdown(0);
});
process.on("SIGTERM", () => {
  shutdown(0);
});
