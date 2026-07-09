import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  parseDateBound,
  parseLogTimestamp,
  readLogs,
  readLogTailAsText,
} from '../../api/logReader';
import { combinedLogPath } from '../../utils/logger';

const SAMPLE = [
  '{"timestamp":"2026-06-15 10:00:00","level":"info","message":"old"}',
  '{"timestamp":"2026-06-15 12:00:00","level":"error","message":"mid"}',
  '{"timestamp":"2026-06-16 08:00:00","level":"info","message":"new"}',
];

function withSampleLog(fn: () => void): void {
  fs.mkdirSync(path.dirname(combinedLogPath), { recursive: true });
  const backup = fs.existsSync(combinedLogPath) ? fs.readFileSync(combinedLogPath, 'utf8') : null;
  fs.writeFileSync(combinedLogPath, SAMPLE.join('\n') + '\n');
  try {
    fn();
  } finally {
    if (backup !== null) fs.writeFileSync(combinedLogPath, backup);
    else fs.unlinkSync(combinedLogPath);
  }
}

describe('parseLogTimestamp', () => {
  it('parses Winston format', () => {
    assert.ok(parseLogTimestamp('2026-06-15 14:30:00') > 0);
  });
});

describe('parseDateBound', () => {
  it('uses start and end of day for YYYY-MM-DD', () => {
    const start = parseDateBound('2026-06-15', false);
    const end = parseDateBound('2026-06-15', true);
    assert.ok(end > start);
  });
});

describe('readLogs', () => {
  it('returns newest first by default (order=desc)', () => {
    withSampleLog(() => {
      const result = readLogs({ lines: 10 });
      assert.equal(result.order, 'desc');
      assert.equal(result.entries[0].message, 'new');
      assert.equal(result.entries[result.entries.length - 1].message, 'old');
    });
  });

  it('sorts ascending when order=asc', () => {
    withSampleLog(() => {
      const result = readLogs({ lines: 10, order: 'asc' });
      assert.equal(result.entries[0].message, 'old');
      assert.equal(result.entries[2].message, 'new');
    });
  });

  it('filters by date range', () => {
    withSampleLog(() => {
      const result = readLogs({ from: '2026-06-15', to: '2026-06-15', lines: 50 });
      assert.equal(result.total, 2);
      assert.ok(result.entries.every((e) => e.message !== 'new'));
    });
  });

  it('filters by level', () => {
    withSampleLog(() => {
      const result = readLogs({ level: 'error', lines: 50 });
      assert.equal(result.total, 1);
      assert.equal(result.entries[0].message, 'mid');
    });
  });

  it('formats text output in sort order', () => {
    withSampleLog(() => {
      const text = readLogTailAsText({ lines: 2, order: 'desc' });
      const firstLine = text.split('\n')[0];
      assert.ok(firstLine.includes('new'));
    });
  });
});
