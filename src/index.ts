import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  createCliRenderer,
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
  delayMs: 500,
  inactiveMs: 2000,
  idleFlushMs: 2000,
  maxLines: 2000,
  startAt: "beginning",
  help: false,
};

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

const renderer = await createCliRenderer({ exitOnCtrlC: true });

const layout = new BoxRenderable(renderer, {
  flexDirection: "column",
  width: "100%",
  height: "100%",
  padding: 1,
  gap: 1,
});

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

const logBox = new ScrollBoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  title: "Merged Logs",
  stickyScroll: true,
  stickyStart: "bottom",
  scrollX: true,
  scrollY: true,
  contentOptions: {
    paddingLeft: 1,
    paddingRight: 1,
  },
});

const logText = new TextRenderable(renderer, {
  wrapMode: "none",
  content: "",
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
  content: "q quit | p/space pause | f follow | c clear",
});
footer.add(footerText);

layout.add(header);
layout.add(logBox);
layout.add(footer);
renderer.root.add(layout);

const fileStates = new Map<string, FileState>();
const pendingFiles = new Set<string>();
const logLines: string[] = [];

let paused = false;
let scheduledRender = false;
let initializing = true;
let isShuttingDown = false;
let flushTimer: NodeJS.Timeout | undefined;

const merger = new LogMerger(
  {
    delayMs: cliOptions.delayMs,
    inactiveMs: cliOptions.inactiveMs,
    idleFlushMs: cliOptions.idleFlushMs,
  },
  (event) => {
    appendLine(formatEvent(event));
  },
);

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Invalid time";
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function formatEvent(event: LogEvent): string {
  return `${formatTimestamp(event.timestamp)} [${event.source}] ${event.line}`;
}

function appendLine(line: string): void {
  logLines.push(line);
  if (logLines.length > cliOptions.maxLines) {
    logLines.splice(0, logLines.length - cliOptions.maxLines);
  }
  scheduleRender();
}

function scheduleRender(): void {
  if (scheduledRender) return;
  scheduledRender = true;
  setTimeout(() => {
    scheduledRender = false;
    logText.content = logLines.join("\n");
    updateStatus();
  }, 16);
}

function updateStatus(): void {
  const statusLine = paused ? "PAUSED" : "LIVE";
  headerText.content = `Dir: ${directory}\nFiles: ${fileStates.size} (filter: ${cliOptions.include}) | Lines: ${logLines.length}/${cliOptions.maxLines}\nDelay: ${cliOptions.delayMs}ms | Inactive: ${cliOptions.inactiveMs}ms | Idle flush: ${cliOptions.idleFlushMs}ms | ${statusLine} | Buffered: ${merger.bufferSize}`;
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

async function scanDirectory(): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      includeRegex.lastIndex = 0;
      return includeRegex.test(entry.name);
    })
    .map((entry) => path.join(directory, entry.name));

  for (const filePath of files) {
    await startWatchingFile(filePath);
  }

  merger.flushAll();
  scheduleRender();
}

const directoryWatcher = fs.watch(directory, { persistent: true }, (eventType, fileName) => {
  if (!fileName) return;
  const name = fileName.toString();
  includeRegex.lastIndex = 0;
  if (!includeRegex.test(name)) return;
  const filePath = path.join(directory, name);

  if (eventType === "rename") {
    fs.promises
      .stat(filePath)
      .then((stat) => {
        if (stat.isFile()) {
          void startWatchingFile(filePath);
        }
      })
      .catch(() => removeFile(filePath));
  }
});

function shutdown(exitCode: number): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  directoryWatcher.close();
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

  if (key.name === "p" || key.name === "space") {
    paused = !paused;
    if (!paused) {
      merger.flushAll();
      scheduleRender();
    }
    updateStatus();
  }

  if (key.name === "f") {
    logBox.stickyScroll = true;
    logBox.stickyStart = "bottom";
    logBox.scrollTo({ y: logBox.scrollHeight });
  }

  if (key.name === "c") {
    logLines.length = 0;
    logText.content = "";
    updateStatus();
  }
});

flushTimer = setInterval(() => {
  if (!paused && !initializing) {
    merger.flushReady();
  }
  updateStatus();
}, 1000);

logLines.push("Waiting for log lines...");
updateStatus();
await scanDirectory();
initializing = false;

process.on("SIGINT", () => {
  shutdown(0);
});
process.on("SIGTERM", () => {
  shutdown(0);
});
