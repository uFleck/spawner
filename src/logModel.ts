import type { Level, LogLine } from "./api";

export type { Level };

export interface Row {
  line: LogLine;
  level: Level;
  frames: LogLine[];
}

const FRAME = /^\s+at\s/;
/** Frames from the runtime and its libraries (.NET base libraries, Node internals and installed packages). Any other frame is the app's own code. */
const FRAMEWORK_FRAME = /^\s+at\s+(?:(?:System|Microsoft|Newtonsoft|Windows)\.|.*(?:node:internal|node_modules))/;

export const isFrame = (line: LogLine) => line.stream !== "sys" && FRAME.test(line.text);
export const isOwnFrame = (line: LogLine) => !FRAMEWORK_FRAME.test(line.text);

/** Folds stack-trace lines under the line that raised them, per instance. */
export function buildRows(logs: LogLine[]): Row[] {
  const rows: Row[] = [];
  const lastByInstance = new Map<string, Row>();
  for (const line of logs) {
    const owner = lastByInstance.get(line.instance);
    if (owner && isFrame(line)) {
      owner.frames.push(line);
      continue;
    }
    const row: Row = { line, level: line.level, frames: [] };
    rows.push(row);
    lastByInstance.set(line.instance, row);
  }
  return rows;
}

/** Consecutive rows that read almost the same. `rows[0]` stands in for the whole run when collapsed. */
export interface Run {
  rows: Row[];
}

const VOLATILE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b|\d+/gi;

/** Share of words that may differ between two lines of the same length before they stop counting as similar. */
const MAX_WORD_DIFF = 0.2;

const QUOTED = /'[^']*'|"[^"]*"/g;
const PATHISH = /^\S*[\\/]\S*$/;

/** Masks what varies between lines of one template: numbers, ids, quoted names, paths and URLs. */
const normalize = (text: string) =>
  text
    .replace(VOLATILE, "#")
    .replace(QUOTED, "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (PATHISH.test(w) ? "?" : w))
    .join(" ");

interface Shape {
  /** Lines only merge when this matches exactly. */
  key: string;
  words: string[];
}

/** MSBuild-style diagnostics (`<file> : warning NU1903: <message>`). Their messages vary so much that only the code family says what they are. */
const WARNING = /^\S.*? : warning ([A-Za-z]+)\d+:/;

const shapeOf = ({ line, level, frames }: Row): Shape => {
  const warning = WARNING.exec(line.text);
  return {
    key: `${line.instance}\0${level}\0${frames.map((f) => normalize(f.text)).join("\n")}`,
    words: warning ? ["warning", warning[1]] : normalize(line.text).split(" "),
  };
};

function similar(a: Shape, b: Shape): boolean {
  if (a.key !== b.key || a.words.length !== b.words.length) return false;
  let diff = 0;
  for (let i = 0; i < a.words.length; i++) if (a.words[i] !== b.words[i]) diff++;
  return diff <= Math.floor(a.words.length * MAX_WORD_DIFF);
}

/** Groups neighbouring rows that are similar to the first row of their run. A lone row is a run of one. */
export function squashRows(rows: Row[]): Run[] {
  const runs: Run[] = [];
  let head: Shape | null = null;
  for (const row of rows) {
    const shape = shapeOf(row);
    if (head && similar(head, shape)) runs[runs.length - 1].rows.push(row);
    else {
      runs.push({ rows: [row] });
      head = shape;
    }
  }
  return runs;
}

const PALETTE = 5;
const colorIndex = new Map<string, number>();

export function colorVar(id: string): string {
  let i = colorIndex.get(id);
  if (i === undefined) {
    i = colorIndex.size % PALETTE;
    colorIndex.set(id, i);
  }
  return `var(--i${i + 1})`;
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

/** `/pattern/` (optionally `/pattern/flags`) is a regex; anything else is a plain substring. */
function parseQuery(query: string): { source: string; isRegex: boolean; flags: string } | null {
  const q = query.trim();
  if (!q) return null;
  const m = REGEX_LITERAL.exec(q);
  if (m) return { source: m[1], isRegex: true, flags: m[2] };
  return { source: q, isRegex: false, flags: "" };
}

export function matcherFor(query: string): ((text: string) => boolean) | null {
  const p = parseQuery(query);
  if (!p) return null;
  if (p.isRegex) {
    try {
      const re = new RegExp(p.source, p.flags.replace(/[gy]/g, "") || "i");
      return (t) => re.test(t);
    } catch {
      return null;
    }
  }
  const lower = p.source.toLowerCase();
  return (t) => t.toLowerCase().includes(lower);
}

export function highlightRegex(query: string): RegExp | null {
  const p = parseQuery(query);
  if (!p) return null;
  try {
    const source = p.isRegex ? p.source : p.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = p.isRegex && p.flags ? p.flags : "i";
    return new RegExp(source, flags.includes("g") ? flags : flags + "g");
  } catch {
    return null;
  }
}

export function countLevels(logs: LogLine[]) {
  let warn = 0;
  let err = 0;
  for (const line of logs) {
    if (isFrame(line)) continue;
    if (line.level === "wrn") warn++;
    else if (line.level === "err") err++;
  }
  return { warn, err };
}

export const clock = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
