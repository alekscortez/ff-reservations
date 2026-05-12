import { describe, expect, it } from 'vitest';
import {
  formatTableLabel,
  formatTableLabelLower,
  TableLabelPipe,
} from './table-label.pipe';

describe('formatTableLabel', () => {
  it('renders "Table N" for a single-table reservation (scalar only)', () => {
    expect(formatTableLabel({ tableId: 'A04' })).toBe('Table A04');
  });
  it('renders "Tables N, M, ..." for multi-table tableIds', () => {
    expect(formatTableLabel({ tableId: 'A04', tableIds: ['A04', 'A05'] })).toBe(
      'Tables A04, A05'
    );
  });
  it('prefers tableIds[] over scalar tableId', () => {
    expect(formatTableLabel({ tableId: 'OLD', tableIds: ['A1', 'B2'] })).toBe(
      'Tables A1, B2'
    );
  });
  it('accepts a raw string[] input', () => {
    expect(formatTableLabel(['A1'])).toBe('Table A1');
    expect(formatTableLabel(['A1', 'B2', 'C3'])).toBe('Tables A1, B2, C3');
  });
  it('accepts a raw string input', () => {
    expect(formatTableLabel('A04')).toBe('Table A04');
    expect(formatTableLabel('  A04  ')).toBe('Table A04');
  });
  it('returns "—" for empty / nullish / whitespace input', () => {
    expect(formatTableLabel(null)).toBe('—');
    expect(formatTableLabel(undefined)).toBe('—');
    expect(formatTableLabel('')).toBe('—');
    expect(formatTableLabel([])).toBe('—');
    expect(formatTableLabel({ tableId: '', tableIds: [] })).toBe('—');
    expect(formatTableLabel({})).toBe('—');
  });
  it('drops empty/whitespace entries from a multi-table list', () => {
    expect(formatTableLabel(['A1', '  ', 'B2'])).toBe('Tables A1, B2');
  });
});

describe('formatTableLabelLower', () => {
  it('renders "table N" / "tables N, M, ..." (lowercase)', () => {
    expect(formatTableLabelLower({ tableId: 'A04' })).toBe('table A04');
    expect(formatTableLabelLower({ tableIds: ['A04', 'A05'] })).toBe(
      'tables A04, A05'
    );
  });
  it('returns "" for empty / nullish input (callers branch on truthy)', () => {
    expect(formatTableLabelLower(null)).toBe('');
    expect(formatTableLabelLower('')).toBe('');
    expect(formatTableLabelLower({})).toBe('');
  });
});

describe('TableLabelPipe', () => {
  const pipe = new TableLabelPipe();
  it('delegates to formatTableLabel', () => {
    expect(pipe.transform({ tableId: 'A04' })).toBe('Table A04');
    expect(pipe.transform({ tableIds: ['A04', 'A05'] })).toBe('Tables A04, A05');
    expect(pipe.transform(null)).toBe('—');
  });
});
