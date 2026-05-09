// Table filter state + persistence (slice 3 of the reservations-new.ts
// frontend split). Drives the table list/map filtering on the Hold &
// Reserve page: status (ALL / AVAILABLE / HOLD / PENDING_PAYMENT /
// RESERVED / DISABLED), section (ALL / A-E), and free-text query.
//
// Storage: status + section persist across sessions in localStorage so
// staff don't lose filtering when they navigate away or reload. Query
// is intentionally not persisted — staff usually want a fresh slate
// when they come back.

import { TableForEvent } from '../../../shared/models/table.model';

export const FILTERS_STORAGE_KEY = 'ff_new_res_filters_v1';

export type TableFilterStatus =
  | 'ALL'
  | 'AVAILABLE'
  | 'HOLD'
  | 'PENDING_PAYMENT'
  | 'RESERVED'
  | 'DISABLED';

export const VALID_STATUS_FILTERS: readonly TableFilterStatus[] = [
  'ALL',
  'AVAILABLE',
  'HOLD',
  'PENDING_PAYMENT',
  'RESERVED',
  'DISABLED',
];

export interface SavedFilterState {
  status: TableFilterStatus;
  section: string;
}

export function readSavedFilters(): Partial<SavedFilterState> | null {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { status?: string; section?: string };
    const out: Partial<SavedFilterState> = {};
    if (
      typeof parsed.status === 'string' &&
      VALID_STATUS_FILTERS.includes(parsed.status as TableFilterStatus)
    ) {
      out.status = parsed.status as TableFilterStatus;
    }
    if (typeof parsed.section === 'string' && parsed.section) {
      out.section = parsed.section;
    }
    return out;
  } catch {
    return null;
  }
}

export function writeSavedFilters(state: SavedFilterState): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Restricted environments (private mode, storage disabled) — drop silently.
  }
}

export function applyTableFilters(
  tables: TableForEvent[],
  query: string,
  status: TableFilterStatus,
  section: string
): TableForEvent[] {
  const normalizedQuery = String(query ?? '').trim().toLowerCase();
  return (tables ?? []).filter((t) => {
    const matchQuery = normalizedQuery ? t.id.toLowerCase().includes(normalizedQuery) : true;
    const matchStatus = status === 'ALL' ? true : t.status === status;
    const matchSection = section === 'ALL' ? true : t.section === section;
    return matchQuery && matchStatus && matchSection;
  });
}

export function formatStatusFilterLabel(status: TableFilterStatus): string {
  if (status === 'ALL') return 'All';
  if (status === 'AVAILABLE') return 'Available';
  if (status === 'HOLD') return 'Hold';
  if (status === 'PENDING_PAYMENT') return 'Pending Payment';
  if (status === 'RESERVED') return 'Reserved';
  return 'Disabled';
}

export function formatSectionFilterLabel(section: string): string {
  return section === 'ALL' ? 'All' : `Section ${section}`;
}
