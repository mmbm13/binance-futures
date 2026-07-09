import fs from 'fs';
import path from 'path';
import { combinedLogPath, errorLogPath } from '../utils/logger';

export type LogFile = 'combined' | 'error';
export type LogSortOrder = 'asc' | 'desc';

export interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
  raw: string;
  meta?: Record<string, unknown>;
}

export interface ReadLogsOptions {
  file?: LogFile;
  /** Max entries returned after filter/sort (default 200, max 2000). */
  lines?: number;
  level?: string;
  search?: string;
  /** Inclusive lower bound: `YYYY-MM-DD` or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: `YYYY-MM-DD` or ISO datetime. */
  to?: string;
  /** `desc` = newest first (default), `asc` = oldest first. */
  order?: LogSortOrder;
}

export interface ReadLogsResult {
  file: LogFile;
  path: string;
  entries: LogEntry[];
  /** Count after filters, before `lines` limit. */
  total: number;
  order: LogSortOrder;
  filters: {
    from?: string;
    to?: string;
    level?: string;
    search?: string;
  };
}

const LOG_PATHS: Record<LogFile, string> = {
  combined: combinedLogPath,
  error: errorLogPath,
};

const MAX_LINES = 2000;
const MAX_DOWNLOAD_LINES = 50_000;

export function resolveLogFile(file?: string): LogFile {
  return file === 'error' ? 'error' : 'combined';
}

export function resolveLogOrder(order?: string): LogSortOrder {
  return order === 'asc' ? 'asc' : 'desc';
}

/** Parse Winston timestamp `YYYY-MM-DD HH:mm:ss` (local) to epoch ms. */
export function parseLogTimestamp(ts?: string): number {
  if (!ts) return 0;
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Parse query date: `YYYY-MM-DD` or full ISO string. */
export function parseDateBound(value: string, endOfDay: boolean): number {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  }
  const ms = new Date(trimmed).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date: "${value}"`);
  }
  return ms;
}

function parseLogLine(line: string): LogEntry {
  const trimmed = line.trim();
  if (!trimmed) {
    return { raw: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const { timestamp, level, message, service, ...rest } = parsed;
    return {
      timestamp: typeof timestamp === 'string' ? timestamp : undefined,
      level: typeof level === 'string' ? level : undefined,
      message: typeof message === 'string' ? message : undefined,
      service: typeof service === 'string' ? service : undefined,
      meta: Object.keys(rest).length > 0 ? rest : undefined,
      raw: trimmed,
    };
  } catch {
    return { raw: trimmed };
  }
}

function formatEntryText(entry: LogEntry): string {
  if (!entry.message && entry.raw) return entry.raw;
  const ts = entry.timestamp ?? '';
  const level = entry.level ?? 'info';
  const msg = entry.message ?? '';
  let line = `${ts} [${level}]: ${msg}`.trim();
  if (entry.meta && Object.keys(entry.meta).length > 0) {
    line += ` ${JSON.stringify(entry.meta)}`;
  }
  return line;
}

function readAllLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

function filterAndSortEntries(
  rawLines: string[],
  options: ReadLogsOptions,
  maxReturn: number
): ReadLogsResult {
  const file = options.file ?? 'combined';
  const order = resolveLogOrder(options.order);
  const filePath = LOG_PATHS[file];
  const levelFilter = options.level?.toLowerCase();
  const search = options.search?.toLowerCase();

  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (options.from) fromMs = parseDateBound(options.from, false);
  if (options.to) toMs = parseDateBound(options.to, true);

  let entries = rawLines
    .filter((l) => l.trim())
    .map(parseLogLine)
    .filter((e) => e.raw);

  if (levelFilter) {
    entries = entries.filter((e) => e.level?.toLowerCase() === levelFilter);
  }
  if (search) {
    entries = entries.filter(
      (e) =>
        e.raw.toLowerCase().includes(search) ||
        e.message?.toLowerCase().includes(search)
    );
  }
  if (fromMs !== undefined || toMs !== undefined) {
    entries = entries.filter((e) => {
      const t = parseLogTimestamp(e.timestamp);
      if (t === 0) return false;
      if (fromMs !== undefined && t < fromMs) return false;
      if (toMs !== undefined && t > toMs) return false;
      return true;
    });
  }

  entries.sort((a, b) => {
    const ta = parseLogTimestamp(a.timestamp);
    const tb = parseLogTimestamp(b.timestamp);
    if (ta !== tb) return order === 'asc' ? ta - tb : tb - ta;
    return order === 'asc' ? a.raw.localeCompare(b.raw) : b.raw.localeCompare(a.raw);
  });

  const total = entries.length;
  const limited = entries.slice(0, maxReturn);

  return {
    file,
    path: filePath,
    entries: limited,
    total,
    order,
    filters: {
      from: options.from,
      to: options.to,
      level: options.level,
      search: options.search,
    },
  };
}

export function readLogs(options: ReadLogsOptions = {}): ReadLogsResult {
  const file = options.file ?? 'combined';
  const maxLines = Math.min(Math.max(options.lines ?? 200, 1), MAX_LINES);
  const rawLines = readAllLines(LOG_PATHS[file]);
  return filterAndSortEntries(rawLines, options, maxLines);
}

/** @deprecated alias — use readLogs */
export function readLogTail(options: ReadLogsOptions): ReadLogsResult {
  return readLogs(options);
}

export function readLogTailAsText(options: ReadLogsOptions): string {
  const maxLines =
    options.lines !== undefined
      ? Math.min(Math.max(options.lines, 1), MAX_DOWNLOAD_LINES)
      : MAX_DOWNLOAD_LINES;
  const { entries } = filterAndSortEntries(readAllLines(LOG_PATHS[options.file ?? 'combined']), options, maxLines);
  return entries.map(formatEntryText).join('\n');
}

export function getLogFilePath(file: LogFile): string {
  return LOG_PATHS[file];
}

export function getLogFileStats(file: LogFile): { exists: boolean; size: number; mtime: string | null } {
  const filePath = LOG_PATHS[file];
  if (!fs.existsSync(filePath)) {
    return { exists: false, size: 0, mtime: null };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}
