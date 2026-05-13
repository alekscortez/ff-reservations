import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { TableForEvent } from '../../models/table.model';

const NAV_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);
const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar']);

@Component({
  selector: 'app-table-map',
  imports: [CommonModule],
  templateUrl: './table-map.html',
  styleUrl: './table-map.scss',
})
export class TableMap implements OnInit, OnChanges, OnDestroy {
  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);
  private elementRef = inject(ElementRef<HTMLElement>);
  private readonly defaultSectionColors: Record<string, string> = {
    A: '#ec008c',
    B: '#2e3192',
    C: '#00aeef',
    D: '#f7941d',
    E: '#711411',
  };

  @Input() tables: TableForEvent[] = [];
  @Input() selectedTableId: string | null = null;
  @Input() svgAssetPath = 'assets/maps/FF_Reservations_Map.normalized.svg';
  @Input() interactive = true;
  @Input() sectionColors: Partial<Record<string, string>> = {};

  @Output() tableSelect = new EventEmitter<TableForEvent>();

  readonly safeSvgMarkup = signal<SafeHtml | null>(null);
  readonly loadError = signal<string | null>(null);

  private baseSvgMarkup = '';
  private loadSub: Subscription | null = null;

  ngOnInit(): void {
    this.loadSvg();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tables'] || changes['selectedTableId'] || changes['interactive']) {
      this.renderSvg();
    }
    if (changes['svgAssetPath'] && !changes['svgAssetPath'].firstChange) {
      this.loadSvg();
    }
  }

  ngOnDestroy(): void {
    this.loadSub?.unsubscribe();
    this.loadSub = null;
  }

  onSvgClick(event: MouseEvent): void {
    if (!this.interactive) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tableEl = target.closest('[data-table-id]');
    if (!(tableEl instanceof Element)) return;
    this.emitTableSelectFromElement(tableEl);
  }

  onSvgKeydown(event: KeyboardEvent): void {
    if (!this.interactive) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tableEl = target.closest('[data-table-id]');
    if (!(tableEl instanceof Element)) return;
    const clickable = tableEl.getAttribute('data-clickable') === 'true';

    if (ACTIVATE_KEYS.has(event.key)) {
      if (!clickable) return;
      event.preventDefault();
      this.emitTableSelectFromElement(tableEl);
      return;
    }

    if (!NAV_KEYS.has(event.key)) return;
    const next = this.findNeighbor(tableEl, event.key);
    if (!next) return;
    event.preventDefault();
    this.moveRover(next);
  }

  private emitTableSelectFromElement(el: Element): void {
    const tableId = String(el.getAttribute('data-table-id') ?? '').trim();
    if (!tableId) return;
    const table = this.tables.find((item) => item.id === tableId);
    if (!table) return;
    if (table.status !== 'AVAILABLE') return;
    this.tableSelect.emit(table);
  }

  private findNeighbor(currentEl: Element, key: string): Element | null {
    const root = this.elementRef.nativeElement.querySelector('.ff-map-root');
    if (!(root instanceof Element)) return null;
    const focusables = Array.from(root.querySelectorAll('[data-clickable="true"]'));
    if (focusables.length === 0) return null;

    if (key === 'Home') return focusables[0] ?? null;
    if (key === 'End') return focusables[focusables.length - 1] ?? null;

    const cur = currentEl.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;

    let best: { el: Element; dist: number } | null = null;
    for (const el of focusables) {
      if (el === currentEl) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;

      let valid = false;
      switch (key) {
        case 'ArrowRight':
          valid = dx > 0.5 && Math.abs(dy) <= Math.abs(dx);
          break;
        case 'ArrowLeft':
          valid = dx < -0.5 && Math.abs(dy) <= Math.abs(dx);
          break;
        case 'ArrowDown':
          valid = dy > 0.5 && Math.abs(dx) <= Math.abs(dy);
          break;
        case 'ArrowUp':
          valid = dy < -0.5 && Math.abs(dx) <= Math.abs(dy);
          break;
      }
      if (!valid) continue;
      const dist = Math.hypot(dx, dy);
      if (best == null || dist < best.dist) best = { el, dist };
    }
    return best?.el ?? null;
  }

  private moveRover(target: Element): void {
    const root = this.elementRef.nativeElement.querySelector('.ff-map-root');
    if (!(root instanceof Element)) return;
    for (const node of Array.from(root.querySelectorAll('[data-clickable="true"]'))) {
      node.setAttribute('tabindex', node === target ? '0' : '-1');
    }
    this.focusElement(target);
  }

  private loadSvg(): void {
    this.loadSub?.unsubscribe();
    this.loadError.set(null);
    this.safeSvgMarkup.set(null);

    const path = String(this.svgAssetPath ?? '').trim();
    if (!path) {
      this.loadError.set('Map SVG path is not configured.');
      return;
    }

    this.loadSub = this.http.get(path, { responseType: 'text' }).subscribe({
      next: (markup) => {
        this.baseSvgMarkup = String(markup ?? '');
        this.renderSvg();
      },
      error: (err) => {
        this.baseSvgMarkup = '';
        this.loadError.set(
          err?.error?.message || err?.message || 'Failed to load reservations map.'
        );
      },
    });
  }

  private renderSvg(): void {
    if (!this.baseSvgMarkup) return;

    const parser = new DOMParser();
    const doc = parser.parseFromString(this.baseSvgMarkup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
      this.loadError.set('Invalid SVG map format.');
      return;
    }

    svg.classList.add('ff-map-root');
    this.loadError.set(null);

    const focusedTableId = this.getFocusedTableId();

    const tableById = new Map(this.tables.map((table) => [table.id, table] as const));
    const candidates = Array.from(doc.querySelectorAll('g[id]'));
    const focusableNodes: Element[] = [];
    for (const node of candidates) {
      const tableId = String(node.getAttribute('id') ?? '').trim();
      if (!/^[A-Z]\d{2,3}$/.test(tableId)) continue;
      const table = tableById.get(tableId);
      if (!table) continue;

      const statusClass = `ff-map-${String(table.status).toLowerCase().replace(/_/g, '-')}`;
      node.classList.add('ff-map-table', statusClass);
      node.setAttribute('data-table-id', table.id);
      node.setAttribute('data-status', table.status);
      const clickable = this.interactive && table.status === 'AVAILABLE';
      node.setAttribute('data-clickable', clickable ? 'true' : 'false');
      if (clickable) {
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', this.buildTableAriaLabel(table));
        node.setAttribute('tabindex', '-1');
        if (table.id === this.selectedTableId) {
          node.setAttribute('aria-pressed', 'true');
        }
        focusableNodes.push(node);
      }
      if (table.id === this.selectedTableId) {
        node.classList.add('ff-map-selected');
        this.appendSelectionMarker(doc, node);
        node.parentNode?.appendChild(node);
      }
      this.applyStatusFill(node, table);
      if (table.status !== 'AVAILABLE') {
        this.hideUnavailableLabel(node);
        this.appendUnavailableMarker(doc, node);
      }

      const existingTitle = node.querySelector(':scope > title');
      if (existingTitle) existingTitle.remove();
      const title = doc.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${table.id} · $${table.price} · ${table.status}`;
      node.insertBefore(title, node.firstChild);
    }

    if (focusableNodes.length > 0) {
      const rover =
        focusableNodes.find(
          (n) => n.getAttribute('data-table-id') === this.selectedTableId
        ) ?? focusableNodes[0];
      rover.setAttribute('tabindex', '0');
    }

    const serialized = new XMLSerializer().serializeToString(svg);
    this.safeSvgMarkup.set(this.sanitizer.bypassSecurityTrustHtml(serialized));

    if (focusedTableId) {
      setTimeout(() => this.restoreFocus(focusedTableId), 0);
    }
  }

  private buildTableAriaLabel(table: TableForEvent): string {
    const status = String(table.status).toLowerCase().replace(/_/g, ' ');
    return `Table ${table.id}, section ${table.section}, $${table.price}, ${status}`;
  }

  private getFocusedTableId(): string | null {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    if (!(active instanceof Element)) return null;
    if (!this.elementRef.nativeElement.contains(active)) return null;
    const tableEl = active.closest('[data-table-id]');
    if (!(tableEl instanceof Element)) return null;
    return String(tableEl.getAttribute('data-table-id') ?? '').trim() || null;
  }

  private restoreFocus(tableId: string): void {
    const target = this.findTableElement(tableId);
    if (!target) return;
    if (target.getAttribute('data-clickable') !== 'true') return;
    this.focusElement(target);
  }

  private findTableElement(tableId: string): Element | null {
    const root = this.elementRef.nativeElement.querySelector('.ff-map-root');
    if (!(root instanceof Element)) return null;
    return root.querySelector(`[data-table-id="${tableId}"]`);
  }

  private focusElement(el: Element): void {
    (el as unknown as { focus?: (opts?: FocusOptions) => void }).focus?.({ preventScroll: false });
  }

  private applyStatusFill(node: Element, table: TableForEvent): void {
    const color =
      table.status === 'AVAILABLE' ? this.availableColorBySection(table.section) : '#9ca3af';
    const primaryShape = this.findPrimaryShape(node);
    if (!(primaryShape instanceof Element)) return;
    primaryShape.setAttribute('fill', color);
    primaryShape.setAttribute('style', `fill:${color} !important;`);
  }

  private appendUnavailableMarker(doc: Document, node: Element): void {
    const primaryShape = this.findPrimaryShape(node);
    if (!(primaryShape instanceof SVGGraphicsElement)) return;
    const box = this.measureGraphicBBox(primaryShape);
    if (!box) return;

    this.createCross(
      doc,
      node,
      box.x + box.width / 2,
      box.y + box.height / 2,
      Math.max(7, Math.min(box.width, box.height) * 0.2),
      Math.max(1, Math.min(box.width, box.height) * 0.014)
    );
  }

  private createCross(
    doc: Document,
    node: Element,
    cx: number,
    cy: number,
    half: number,
    strokeWidth: number
  ): void {
    const mark = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    mark.setAttribute('class', 'ff-map-unavailable-mark');
    mark.setAttribute('pointer-events', 'none');

    const createLine = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      color: string,
      width: number
    ) => {
      const line = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('stroke-width', String(width));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-linecap', 'round');
      return line;
    };

    // White underlay improves visibility over any fill color.
    mark.appendChild(
      createLine(cx - half, cy - half, cx + half, cy + half, '#ffffff', strokeWidth + 0.45)
    );
    mark.appendChild(
      createLine(cx - half, cy + half, cx + half, cy - half, '#ffffff', strokeWidth + 0.45)
    );
    mark.appendChild(
      createLine(cx - half, cy - half, cx + half, cy + half, '#dc2626', strokeWidth)
    );
    mark.appendChild(
      createLine(cx - half, cy + half, cx + half, cy - half, '#dc2626', strokeWidth)
    );

    node.appendChild(mark);
  }

  private appendSelectionMarker(doc: Document, node: Element): void {
    const primaryShape = this.findPrimaryShape(node);
    if (!(primaryShape instanceof SVGGraphicsElement)) return;
    const box = this.measureGraphicBBox(primaryShape);
    if (!box) return;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = Math.max(12, box.width / 2 + 4);
    const ry = Math.max(12, box.height / 2 + 4);

    const ringUnderlay = doc.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    ringUnderlay.setAttribute('class', 'ff-map-selected-ring ff-map-selected-ring-underlay');
    ringUnderlay.setAttribute('cx', String(cx));
    ringUnderlay.setAttribute('cy', String(cy));
    ringUnderlay.setAttribute('rx', String(rx));
    ringUnderlay.setAttribute('ry', String(ry));
    ringUnderlay.setAttribute('pointer-events', 'none');

    const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    ring.setAttribute('class', 'ff-map-selected-ring');
    ring.setAttribute('cx', String(cx));
    ring.setAttribute('cy', String(cy));
    ring.setAttribute('rx', String(rx));
    ring.setAttribute('ry', String(ry));
    ring.setAttribute('pointer-events', 'none');

    node.appendChild(ringUnderlay);
    node.appendChild(ring);
  }

  private hideUnavailableLabel(node: Element): void {
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
      return;
    }

    for (const path of Array.from(node.querySelectorAll(':scope > path.st15'))) {
      path.setAttribute('opacity', '0');
    }
  }

  private findPrimaryShape(node: Element): Element | null {
    const selectors = [
      ':scope > g:first-child > ellipse',
      ':scope > g:first-child > circle',
      ':scope > g:first-child > rect',
      ':scope > g:first-child > polygon',
      ':scope > g:first-child > path',
      ':scope > ellipse',
      ':scope > circle',
      ':scope > rect',
      ':scope > polygon',
      ':scope > path',
    ];
    for (const selector of selectors) {
      const found = node.querySelector(selector);
      if (found instanceof Element) return found;
    }
    return null;
  }

  private availableColorBySection(section: string): string {
    const key = String(section ?? '').trim().toUpperCase();
    const customColor = this.sectionColors[key];
    if (customColor && this.isHexColor(customColor)) {
      return customColor;
    }
    return this.defaultSectionColors[key] ?? this.defaultSectionColors['A'];
  }

  private isHexColor(value: string): boolean {
    return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(String(value).trim());
  }

  private measureGraphicBBox(shape: SVGGraphicsElement): DOMRect | null {
    const direct = this.safeBBox(shape);
    if (direct) return direct;
    if (typeof document === 'undefined') return null;

    const ns = 'http://www.w3.org/2000/svg';
    const tempSvg = document.createElementNS(ns, 'svg');
    tempSvg.setAttribute('xmlns', ns);
    tempSvg.setAttribute('width', '1');
    tempSvg.setAttribute('height', '1');
    tempSvg.setAttribute('viewBox', '0 0 1 1');
    tempSvg.style.position = 'fixed';
    tempSvg.style.left = '-9999px';
    tempSvg.style.top = '-9999px';
    tempSvg.style.opacity = '0';
    tempSvg.style.pointerEvents = 'none';
    tempSvg.style.overflow = 'visible';

    const clone = shape.cloneNode(true);
    if (!(clone instanceof SVGGraphicsElement)) return null;
    tempSvg.appendChild(clone);
    document.body.appendChild(tempSvg);
    try {
      return this.safeBBox(clone);
    } finally {
      tempSvg.remove();
    }
  }

  private safeBBox(shape: SVGGraphicsElement): DOMRect | null {
    try {
      const box = shape.getBBox();
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
      if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
      if (box.width <= 0 || box.height <= 0) return null;
      return box;
    } catch {
      return null;
    }
  }
}
