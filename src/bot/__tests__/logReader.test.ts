import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { readLogTail, readLogTailAsText } from '../../api/logReader';
import { combinedLogPath } from '../../utils/logger';

describe('readLogTail', () => {
  it('returns parsed entries from combined log', () => {
    if (!fs.existsSync(combinedLogPath)) {
      fs.mkdirSync(path.dirname(combinedLogPath), { recursive: true });
      fs.writeFileSync(
        combinedLogPath,
        '{"timestamp":"2026-01-01 00:00:00","level":"info","message":"test log"}\n'
      );
    }

    const result = readLogTail({ lines: 5 });
    assert.ok(result.entries.length >= 1);
    assert.ok(result.entries.some((e: { message?: string; raw: string }) => e.message?.includes('test') || e.raw.length > 0));
  });

  it('formats text output', () => {
    const text = readLogTailAsText({ lines: 3 });
    assert.equal(typeof text, 'string');
  });
});
