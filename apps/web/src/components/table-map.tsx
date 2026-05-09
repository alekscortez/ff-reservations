import { useEffect, useRef, useState } from 'react';
import type { TableForEvent } from '@/lib/api/tables';

const SVG_URL = '/maps/FF_Reservations_Map.normalized.svg';

interface TableMapProps {
  tables: TableForEvent[];
  selectedTableId?: string | null;
  interactive?: boolean;
  onSelect?: (table: TableForEvent) => void;
  className?: string;
}

const STATUS_FILL: Record<TableForEvent['status'], string> = {
  AVAILABLE: '#16a34a',
  HOLD: '#f59e0b',
  PENDING_PAYMENT: '#fb923c',
  RESERVED: '#dc2626',
  DISABLED: '#9ca3af',
  UNAVAILABLE: '#9ca3af',
};

function applyStatuses(
  container: HTMLElement,
  tables: TableForEvent[],
  selectedId: string | null,
  interactive: boolean
) {
  const svg = container.querySelector('svg');
  if (!svg) return;
  svg.setAttribute('class', 'ff-table-map-svg');

  const byId = new Map(tables.map((t) => [t.id, t] as const));
  const groups = svg.querySelectorAll('g[id]');
  groups.forEach((g) => {
    const id = g.getAttribute('id') ?? '';
    const table = byId.get(id);
    if (!table) return;
    g.setAttribute('data-table-id', id);
    g.setAttribute('data-status', table.status);
    g.setAttribute('data-selected', selectedId === id ? 'true' : 'false');
    if (interactive && table.status === 'AVAILABLE') {
      (g as SVGElement).style.cursor = 'pointer';
    } else {
      (g as SVGElement).style.cursor = 'not-allowed';
    }
    const firstShape = g.querySelector('g > path');
    if (firstShape) {
      (firstShape as SVGElement).setAttribute('fill', STATUS_FILL[table.status]);
    }
  });
}

export function TableMap({
  tables,
  selectedTableId = null,
  interactive = true,
  onSelect,
  className,
}: TableMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [svgLoaded, setSvgLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetch(SVG_URL)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((markup) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = markup;
        setSvgLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError((err as Error)?.message ?? 'Map failed to load');
        setSvgLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (svgLoaded && containerRef.current) {
      applyStatuses(containerRef.current, tables, selectedTableId, interactive);
    }
  }, [svgLoaded, tables, selectedTableId, interactive]);

  function handleClick(e: React.MouseEvent) {
    if (!interactive || !onSelect) return;
    const target = e.target as Element | null;
    const node = target?.closest('[data-table-id]');
    if (!node) return;
    const id = node.getAttribute('data-table-id') ?? '';
    const table = tables.find((t) => t.id === id);
    if (!table || table.status !== 'AVAILABLE') return;
    onSelect(table);
  }

  return (
    <div className={className}>
      <style>{`
        .ff-table-map-svg { width: 100%; height: auto; max-height: 70vh; }
        .ff-table-map-svg g[data-table-id][data-selected="true"] {
          outline: 4px solid #2563eb;
          outline-offset: -4px;
        }
        .ff-table-map-svg g[data-status="AVAILABLE"]:hover > g:first-of-type > path:first-of-type {
          filter: brightness(1.1);
        }
      `}</style>
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      <div ref={containerRef} onClick={handleClick} className="overflow-auto" />
    </div>
  );
}
