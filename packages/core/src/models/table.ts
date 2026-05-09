export type TableStatus =
  | 'AVAILABLE'
  | 'HOLD'
  | 'PENDING_PAYMENT'
  | 'RESERVED'
  | 'DISABLED';

export interface TableTemplate {
  version: string;
  sections: Record<string, number>;
  tables: TableInfo[];
}

export interface TableInfo {
  id: string;
  number: number;
  section: string;
  price: number;
}

export interface TableForEvent extends TableInfo {
  status: TableStatus;
  disabled: boolean;
}
