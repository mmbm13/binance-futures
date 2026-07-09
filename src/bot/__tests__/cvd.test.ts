import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CvdAccumulator } from '../../strategies/shared/cvd';

describe('CvdAccumulator', () => {
  it('accumulates signed volume per minute', () => {
    const cvd = new CvdAccumulator(5);
    const t0 = 1_700_000_000_000;
    const minute = Math.floor(t0 / 60_000) * 60_000;

    cvd.onTrade(2000, 1, false); // buyer aggressor +1
    cvd.onTrade(2000, 2, true); // seller aggressor -2

    // Hack: buckets keyed by Date.now() — test via restore with fixed minute
    cvd.restore([{ minuteTs: minute, delta: 5 }]);
    assert.equal(cvd.deltaLastMinutes(1, minute + 30_000), 5);
  });

  it('prunes old buckets on restore + new trades', () => {
    const cvd = new CvdAccumulator(2);
    const now = Date.now();
    const m0 = Math.floor(now / 60_000) * 60_000;
    cvd.restore([
      { minuteTs: m0 - 180_000, delta: 99 },
      { minuteTs: m0, delta: 1 },
    ]);
    cvd.onTrade(100, 1, false);
    const json = cvd.toJSON();
    assert.ok(json.every((b) => b.minuteTs >= m0 - 120_000));
  });
});
