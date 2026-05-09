import { useEffect, useRef, useState } from 'react';
import type { TableForEvent } from '@/lib/api/tables';

const SVG_URL = '/maps/FF_Reservations_Map.normalized.svg';
const UNAVAILABLE_FILL = '#9ca3af';
const SELECTION_STROKE = '#111827';
const X_STROKE = '#dc2626';

const DEFAULT_SECTION_COLORS: Record<string, string> = {
  A: '#ec008c',
  B: '#2e3192',
  C: '#00aeef',
  D: '#f7941d',
  E: '#711411',
};

interface TableMapProps {
  tables: TableForEvent[];
  selectedTableId?: string | null;
  interactive?: boolean;
  onSelect?: (table: TableForEvent) => void;
  className?: string;
  sectionColors?: Partial<Record<string, string>>;
}

const TABLE_ID_PATTERN = /^[A-Z]\d{2,3}$/;

function isHexColor(v: string): boolean {
  return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(v.trim());
}

function colorForAvailable(
  section: string,
  override: Partial<Record<string, string>>
): string {
  const key = (section ?? '').trim().toUpperCase();
  const custom = override?.[key];
  if (custom && isHexColor(custom)) return custom;
  return DEFAULT_SECTION_COLORS[key] ?? DEFAULT_SECTION_COLORS.A;
}

function findPrimaryShape(node: Element): SVGGraphicsElement | null {
  const selectors = [
    ':scope > g:first-of-type > ellipse',
    ':scope > g:first-of-type > circle',
    ':scope > g:first-of-type > rect',
    ':scope > g:first-of-type > polygon',
    ':scope > g:first-of-type > path',
    ':scope > ellipse',
    ':scope > circle',
    ':scope > rect',
    ':scope > polygon',
    ':scope > path',
  ];
  for (const sel of selectors) {
    const f = node.querySelector(sel);
    if (f instanceof SVGGraphicsElement) return f;
  }
  return null;
}

function safeBBox(shape: SVGGraphicsElement): DOMRect | null {
  try {
    const box = shape.getBBox();
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      return null;
    }
    return box;
  } catch {
    return null;
  }
}

function hideUnavailableLabel(node: Element) {
  const childGroups = Array.from(node.querySelectorAll(':scope > g'));
  if (childGroups.length >= 2) {
    for (let i = 1; i < childGroups.length; i += 1) {
      childGroups[i].setAttribute('opacity', '0');
    }
    return;
  }
  const directPaths = Array.from(node.querySelectorAll(':scope > path'));
  if (directPaths.length > 2) {
    for (let i = 1; i < directPaths.length - 1; i += 1) {
      directPaths[i].setAttribute('opacity', '0');
    }
  }
}

function clearOverlays(node: Element) {
  for (const overlay of Array.from(node.querySelectorAll(':scope > .ff-map-overlay'))) {
    overlay.remove();
  }
}

function createOverlay(doc: Document): SVGGElement {
  const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'ff-map-overlay');
  g.setAttribute('pointer-events', 'none');
  return g;
}

function appendUnavailableMark(doc: Document, node: Element) {
  const primary = findPrimaryShape(node);
  if (!primary) return;
  const box = safeBBox(primary);
  if (!box) return;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const half = Math.max(7, Math.min(box.width, box.height) * 0.2);
  const stroke = Math.max(1, Math.min(box.width, box.height) * 0.014);

  const overlay = createOverlay(doc);
  overlay.classList.add('ff-map-unavailable-mark');

  const line = (x1: number, y1: number, x2: number, y2: number, color: string, w: number) => {
    const l = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', String(x1));
    l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2));
    l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', color);
    l.setAttribute('stroke-width', String(w));
    l.setAttribute('stroke-linecap', 'round');
    return l;
  };

  // White underlay, then red foreground.
  overlay.appendChild(
    line(cx - half, cy - half, cx + half, cy + half, '#ffffff', stroke + 0.45)
  );
  overlay.appendChild(
    line(cx - half, cy + half, cx + half, cy - half, '#ffffff', stroke + 0.45)
  );
  overlay.appendChild(line(cx - half, cy - half, cx + half, cy + half, X_STROKE, stroke));
  overlay.appendChild(line(cx - half, cy + half, cx + half, cy - half, X_STROKE, stroke));

  node.appendChild(overlay);
}

function appendSelectionRing(doc: Document, node: Element) {
  const primary = findPrimaryShape(node);
  if (!primary) return;
  const box = safeBBox(primary);
  if (!box) return;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = Math.max(12, box.width / 2 + 4);
  const ry = Math.max(12, box.height / 2 + 4);

  const overlay = createOverlay(doc);
  overlay.classList.add('ff-map-selected-overlay');

  const ellipse = (cls: string) => {
    const e = doc.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    e.setAttribute('cx', String(cx));
    e.setAttribute('cy', String(cy));
    e.setAttribute('rx', String(rx));
    e.setAttribute('ry', String(ry));
    e.setAttribute('class', cls);
    e.setAttribute('fill', 'none');
    return e;
  };

  // White underlay (fat) so the ring is visible on any background, then dark ring on top.
  const underlay = ellipse('ff-map-selected-ring-underlay');
  underlay.setAttribute('stroke', '#ffffff');
  underlay.setAttribute('stroke-width', '4.6');
  underlay.setAttribute('vector-effect', 'non-scaling-stroke');

  const ring = ellipse('ff-map-selected-ring');
  ring.setAttribute('stroke', SELECTION_STROKE);
  ring.setAttribute('stroke-width', '2.2');
  ring.setAttribute('vector-effect', 'non-scaling-stroke');

  overlay.appendChild(underlay);
  overlay.appendChild(ring);
  node.appendChild(overlay);
}

function applyStatuses(
  container: HTMLElement | null,
  tables: TableForEvent[],
  selectedId: string | null,
  interactive: boolean,
  sectionColors: Partial<Record<string, string>>
) {
  if (!container) return;
  const svg = container.querySelector('svg');
  if (!svg) return;
  const doc = svg.ownerDocument;

  svg.classList.add('ff-map-root');
  svg.setAttribute('class', 'ff-map-root');

  const byId = new Map(tables.map((t) => [t.id, t]));

  const groups = Array.from(svg.querySelectorAll('g[id]'));
  for (const node of groups) {
    const id = (node.getAttribute('id') ?? '').trim();
    if (!TABLE_ID_PATTERN.test(id)) continue;
    const table = byId.get(id);
    if (!table) continue;

    const statusKey = String(table.status).toLowerCase().replace(/_/g, '-');
    const statusClass = `ff-map-${statusKey}`;
    node.setAttribute(
      'class',
      `ff-map-table ${statusClass}${
        selectedId === id ? ' ff-map-selected' : ''
      }`
    );
    node.setAttribute('data-table-id', id);
    node.setAttribute('data-status', table.status);
    node.setAttribute(
      'data-clickable',
      interactive && table.status === 'AVAILABLE' ? 'true' : 'false'
    );

    // Reset any prior overlays so re-renders don't stack X marks / rings.
    clearOverlays(node);

    // Restore any digit-label opacity we hid on a prior render.
    Array.from(node.querySelectorAll(':scope > g')).forEach((g, idx) => {
      if (idx === 0) return;
      g.removeAttribute('opacity');
    });

    // Fill the primary shape based on status.
    const fillColor =
      table.status === 'AVAILABLE'
        ? colorForAvailable(table.section, sectionColors)
        : UNAVAILABLE_FILL;
    const primary = findPrimaryShape(node);
    if (primary) {
      primary.setAttribute('fill', fillColor);
      primary.setAttribute('style', `fill:${fillColor} !important;`);
    }

    if (table.status !== 'AVAILABLE') {
      hideUnavailableLabel(node);
      appendUnavailableMark(doc, node);
    }

    if (selectedId === id) {
      appendSelectionRing(doc, node);
      // Re-append so the selected table renders on top of its siblings.
      node.parentNode?.appendChild(node);
    }

    // Native browser tooltip on hover.
    const existingTitle = node.querySelector(':scope > title');
    if (existingTitle) existingTitle.remove();
    const title = doc.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${table.id} · $${table.price} · ${table.status}`;
    node.insertBefore(title, node.firstChild);
  }
}

export function TableMap({
  tables,
  selectedTableId = null,
  interactive = true,
  onSelect,
  className,
  sectionColors,
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
      applyStatuses(
        containerRef.current,
        tables,
        selectedTableId,
        interactive,
        sectionColors ?? {}
      );
    }
  }, [svgLoaded, tables, selectedTableId, interactive, sectionColors]);

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
        .ff-map-root { display: block; width: 100%; height: auto; max-height: 70vh; }
        .ff-map-table { transition: opacity 140ms ease, filter 140ms ease; }
        .ff-map-table[data-clickable='true'] { cursor: pointer; }
        .ff-map-table[data-clickable='false'] { cursor: not-allowed; }
        .ff-map-table.ff-map-disabled { opacity: 0.42; }
        .ff-map-table.ff-map-available:hover { filter: brightness(1.1); }
        .ff-map-table.ff-map-selected { filter: drop-shadow(0 0 0.3rem rgba(17, 24, 39, 0.45)); }
      `}</style>
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      <div ref={containerRef} onClick={handleClick} className="overflow-auto" />
    </div>
  );
}
