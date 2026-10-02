import { describe, expect, it } from 'vitest';
import { fmtEng, parseEng } from '../src/core/units';
import { seriesValues, snap, snapUp, stepSeries } from '../src/core/eseries';

describe('parseEng', () => {
  it.each([
    ['4.7k', 4700], ['4k7', 4700], ['22n', 22e-9], ['2n2', 2.2e-9], ['1u', 1e-6], ['1µ', 1e-6],
    ['1M', 1e6], ['1meg', 1e6], ['4R7', 4.7], ['470', 470], ['1e-9', 1e-9], ['10kΩ', 10e3], ['22nF', 22e-9], ['1.5 kHz', 1500],
  ])('%s → %d', (s, v) => expect(parseEng(s)).toBeCloseTo(v, 15));

  it('rejects junk', () => {
    expect(parseEng('abc')).toBeNaN();
    expect(parseEng('')).toBeNaN();
  });
});

describe('fmtEng', () => {
  it.each([
    [4700, 'Ω', '4.7 kΩ'], [22e-9, 'F', '22 nF'], [1e6, '', '1M'], [999.7, 'Hz', '1 kHz'], [0, 'F', '0 F'], [1234.5, '', '1.23k'],
  ])('%d %s → %s', (v, u, s) => expect(fmtEng(v, u)).toBe(s));
  it('handles missing values', () => expect(fmtEng(null)).toBe('—'));
});

describe('E-series', () => {
  it('snaps to the nearest value', () => {
    expect(snap(5310, 'E24')).toBe(5100);
    expect(snap(5310, 'E12')).toBe(5600);
    expect(snap(9.6e-9, 'E6')).toBe(10e-9);
  });
  it('snaps up', () => {
    expect(snapUp(4.05e-8, 'E12')).toBeCloseTo(4.7e-8, 15);
    expect(snapUp(4.7e-8, 'E12')).toBeCloseTo(4.7e-8, 15);
  });
  it('steps across decades', () => {
    expect(stepSeries(8200, 'E12', 1)).toBe(10000);
    expect(stepSeries(10000, 'E12', -1)).toBe(8200);
  });
  it('lists values in a range', () => {
    expect(seriesValues('E6', 1e3, 10e3)).toEqual([1000, 1500, 2200, 3300, 4700, 6800, 10000]);
  });
});
