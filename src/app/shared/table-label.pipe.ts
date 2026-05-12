import { Pipe, PipeTransform } from '@angular/core';

// Single source of truth for "Table X" / "Tables X, Y, Z" rendering.
// Accepts either a reservation-shaped object ({tableId, tableIds?}), a
// raw string[], or null/undefined. Used by the TableLabel pipe and any
// TS-side label/note builder that wants the same wording.
export function formatTableLabel(
  value:
    | {
        tableId?: string | null;
        tableIds?: string[] | null;
      }
    | string[]
    | string
    | null
    | undefined
): string {
  const list = normalizeTableLabelInput(value);
  if (list.length === 0) return '—';
  if (list.length === 1) return `Table ${list[0]}`;
  return `Tables ${list.join(', ')}`;
}

// Lowercase variant for inline use ("for table A1" / "for tables A1, A2").
// Same back-compat rules.
export function formatTableLabelLower(
  value:
    | {
        tableId?: string | null;
        tableIds?: string[] | null;
      }
    | string[]
    | string
    | null
    | undefined
): string {
  const list = normalizeTableLabelInput(value);
  if (list.length === 0) return '';
  if (list.length === 1) return `table ${list[0]}`;
  return `tables ${list.join(', ')}`;
}

function normalizeTableLabelInput(
  value:
    | {
        tableId?: string | null;
        tableIds?: string[] | null;
      }
    | string[]
    | string
    | null
    | undefined
): string[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    const single = value.trim();
    return single ? [single] : [];
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  }
  const arr = Array.isArray(value.tableIds)
    ? value.tableIds.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  if (arr.length > 0) return arr;
  const single = String(value.tableId ?? '').trim();
  return single ? [single] : [];
}

@Pipe({
  name: 'tableLabel',
  standalone: true,
})
export class TableLabelPipe implements PipeTransform {
  transform(
    value:
      | {
          tableId?: string | null;
          tableIds?: string[] | null;
        }
      | string[]
      | string
      | null
      | undefined
  ): string {
    return formatTableLabel(value);
  }
}
