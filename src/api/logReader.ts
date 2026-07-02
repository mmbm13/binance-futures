import fs from 'fs';
import path from 'path';
import { combinedLogPath, errorLogPath } from '../utils/logger';

export type LogFile = 'combined' | 'error';

export interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
  raw: string;
  meta?: Record<string, unknown>;
}

const LOG_PATHS: Record<LogFile, string> = {
  combined: combinedLogPath,
  error: errorLogPath,
};

export function resolveLogFile(file?: string): LogFile {
  return file === 'error' ? 'error' : 'combined';
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

export function readLogTail(options: {
  file?: LogFile;
  lines?: number;
  level?: string;
  search?: string;
}): { file: LogFile; path: string; entries: LogEntry[]; total: number } {
  const file = options.file ?? 'combined';
  const maxLines = Math.min(Math.max(options.lines ?? 200, 1), 2000);
  const filePath = LOG_PATHS[file];
  const levelFilter = options.level?.toLowerCase();
  const search = options.search?.toLowerCase();

  let lines = readAllLines(filePath);
  if (levelFilter) {
    lines = lines.filter((line) => {
      const entry = parseLogLine(line);
      return entry.level?.toLowerCase() === levelFilter;
    });
  }
  if (search) {
    lines = lines.filter((line) => line.toLowerCase().includes(search));
  }

  const total = lines.length;
  const slice = lines.slice(-maxLines).filter((l) => l.trim());
  const entries = slice.map(parseLogLine);

  return { file, path: filePath, entries, total };
}

export function readLogTailAsText(options: {
  file?: LogFile;
  lines?: number;
  level?: string;
  search?: string;
}): string {
  const { entries } = readLogTail(options);
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
