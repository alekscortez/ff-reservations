import { beforeEach, describe, expect, it } from 'vitest';
import { TableForEvent } from '../../../shared/models/table.model';
import {
  applyTableFilters,
  FILTERS_STORAGE_KEY,
  formatSectionFilterLabel,
  formatStatusFilterLabel,
  readSavedFilters,
  TableFilterStatus,
  VALID_STATUS_FILTERS,
  writeSavedFilters,
} from './reservations-new-filters';

function makeTable(overrides: Partial<TableForEvent> = {}): TableForEvent {
  return {
    id: 'A1',
    section: 'A',
    status: 'AVAILABLE',
    price: 100,
    ...overrides,
  } as TableForEvent;
}

describe('VALID_STATUS_FILTERS', () => {
  it('lists all 6 status options', () => {
    expect(VALID_STATUS_FILTERS).toEqual([
      'ALL',
      'AVAILABLE',
      'HOLD',
      'PENDING_PAYMENT',
      'RESERVED',
      'DISABLED',
    ]);
  });
});

describe('writeSavedFilters + readSavedFilters', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips status + section', () => {
    writeSavedFilters({ status: 'HOLD', section: 'B' });
    expect(readSavedFilters()).toEqual({ status: 'HOLD', section: 'B' });
  });

  it('returns null when nothing is stored', () => {
    expect(readSavedFilters()).toBe(null);
  });

  it('returns null on malformed JSON', () => {
    localStorage.setItem(FILTERS_STORAGE_KEY, '{not json');
    expect(readSavedFilters()).toBe(null);
  });

  it('drops invalid status values silently', () => {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({ status: 'WHATEVER', section: 'A' })
    );
    const out = readSavedFilters();
    expect(out?.status).toBeUndefined();
    expect(out?.section).toBe('A');
  });

  it('drops empty section silently', () => {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({ status: 'HOLD', section: '' })
    );
    const out = readSavedFilters();
    expect(out?.status).toBe('HOLD');
    expect(out?.section).toBeUndefined();
  });

  it('returns an empty partial when neither key is valid', () => {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({ status: 'BAD', section: '' })
    );
    expect(readSavedFilters()).toEqual({});
  });

  it('writes via FILTERS_STORAGE_KEY exactly (regression for key drift)', () => {
    writeSavedFilters({ status: 'AVAILABLE', section: 'ALL' });
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    expect(raw).toBe(JSON.stringify({ status: 'AVAILABLE', section: 'ALL' }));
  });
});

describe('applyTableFilters', () => {
  const tables = [
    makeTable({ id: 'A1', section: 'A', status: 'AVAILABLE' }),
    makeTable({ id: 'A2', section: 'A', status: 'HOLD' }),
    makeTable({ id: 'B1', section: 'B', status: 'AVAILABLE' }),
    makeTable({ id: 'B2', section: 'B', status: 'RESERVED' }),
    makeTable({ id: 'C1', section: 'C', status: 'PENDING_PAYMENT' }),
    makeTable({ id: 'D1', section: 'D', status: 'DISABLED' }),
  ];

  it('returns all tables on ALL/ALL/empty query', () => {
    expect(applyTableFilters(tables, '', 'ALL', 'ALL')).toHaveLength(6);
  });

  it('filters by status', () => {
    expect(applyTableFilters(tables, '', 'AVAILABLE', 'ALL').map((t) => t.id)).toEqual([
      'A1',
      'B1',
    ]);
  });

  it('filters by section', () => {
    expect(applyTableFilters(tables, '', 'ALL', 'A').map((t) => t.id)).toEqual(['A1', 'A2']);
  });

  it('filters by query (case-insensitive substring on table id)', () => {
    expect(applyTableFilters(tables, 'a1', 'ALL', 'ALL').map((t) => t.id)).toEqual(['A1']);
    expect(applyTableFilters(tables, 'A', 'ALL', 'ALL').map((t) => t.id)).toEqual([
      'A1',
      'A2',
    ]);
  });

  it('combines status + section + query (AND semantics)', () => {
    expect(applyTableFilters(tables, '1', 'AVAILABLE', 'A').map((t) => t.id)).toEqual([
      'A1',
    ]);
  });

  it('returns [] when no tables match', () => {
    expect(applyTableFilters(tables, '', 'AVAILABLE', 'D')).toEqual([]);
  });

  it('handles whitespace + case in query', () => {
    expect(applyTableFilters(tables, '  A1  ', 'ALL', 'ALL').map((t) => t.id)).toEqual([
      'A1',
    ]);
  });

  it('handles null/empty inputs gracefully', () => {
    expect(applyTableFilters(null as any, '', 'ALL', 'ALL')).toEqual([]);
    expect(applyTableFilters([], '', 'ALL', 'ALL')).toEqual([]);
  });
});

describe('formatStatusFilterLabel', () => {
  const cases: Array<[TableFilterStatus, string]> = [
    ['ALL', 'All'],
    ['AVAILABLE', 'Available'],
    ['HOLD', 'Hold'],
    ['PENDING_PAYMENT', 'Pending Payment'],
    ['RESERVED', 'Reserved'],
    ['DISABLED', 'Disabled'],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input} -> ${expected}`, () => {
      expect(formatStatusFilterLabel(input)).toBe(expected);
    });
  }
});

describe('formatSectionFilterLabel', () => {
  it('returns "All" for ALL', () => {
    expect(formatSectionFilterLabel('ALL')).toBe('All');
  });
  it('prepends "Section" for any other value', () => {
    expect(formatSectionFilterLabel('A')).toBe('Section A');
    expect(formatSectionFilterLabel('B')).toBe('Section B');
    expect(formatSectionFilterLabel('xyz')).toBe('Section xyz');
  });
});
