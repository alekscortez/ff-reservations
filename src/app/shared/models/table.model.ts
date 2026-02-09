export type TableStatus = 'AVAILABLE' | 'HOLD' | 'RESERVED' | 'DISABLED';

export interface TableTemplate {
  version: string;
  sections: Record<string, number>;
  tables: TableInfo[];
}

export interface TableInfo {
  id: string; // e.g., A01
  number: number;
  section: string; // A, B, C, D, E
  price: number;
}

export interface TableForEvent extends TableInfo {
  status: TableStatus;
  disabled: boolean;
}
