import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import {
  PublicAvailabilityResponse,
  PublicAvailabilityService,
  PublicAvailabilityTable,
} from '../../../core/http/public-availability.service';
import { TableMap } from '../../../shared/components/table-map/table-map';
import { TableForEvent } from '../../../shared/models/table.model';

@Component({
  selector: 'app-public-availability',
  imports: [CommonModule, ReactiveFormsModule, TableMap],
  templateUrl: './availability.html',
  styleUrl: './availability.scss',
})
export class PublicAvailability implements OnInit, OnDestroy {
  private api = inject(PublicAvailabilityService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private readonly defaultSectionColors: Record<string, string> = {
    A: '#ec008c',
    B: '#2e3192',
    C: '#00aeef',
    D: '#f7941d',
    E: '#711411',
  };

  loading = false;
  error: string | null = null;
  data: PublicAvailabilityResponse | null = null;

  viewMode = new FormControl<'MAP' | 'LIST'>('MAP', { nonNullable: true });
  search = new FormControl('', { nonNullable: true });
  availableOnly = new FormControl(true, { nonNullable: true });

  private pollSub: Subscription | null = null;
  private pollingSeconds = 0;
  private queryEventDate = '';

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const date = String(params.get('eventDate') ?? '').trim();
        this.queryEventDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
        this.loadAvailability(this.queryEventDate || undefined);
      });
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  onEventDateChange(value: string): void {
    const eventDate = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { eventDate },
      queryParamsHandling: 'merge',
    });
  }

  setViewMode(mode: 'MAP' | 'LIST'): void {
    this.viewMode.setValue(mode);
  }

  isViewMode(mode: 'MAP' | 'LIST'): boolean {
    return this.viewMode.value === mode;
  }

  filteredTables(): PublicAvailabilityTable[] {
    const rows = this.data?.tables ?? [];
    const query = this.search.value.trim().toLowerCase();
    const availableOnly = this.availableOnly.value;
    return rows
      .filter((item) => (availableOnly ? item.available : true))
      .filter((item) => (query ? item.id.toLowerCase().includes(query) : true))
      .sort((a, b) => this.compareTableId(a.id, b.id));
  }

  mapTables(): TableForEvent[] {
    const source = this.data?.tables ?? [];
    return source.map((item) => ({
      id: item.id,
      number: item.number,
      section: item.section,
      price: item.price,
      status: item.available ? 'AVAILABLE' : 'DISABLED',
      disabled: !item.available,
    }));
  }

  asOfLabel(): string {
    const epoch = Number(this.data?.asOfEpoch ?? 0);
    if (!Number.isFinite(epoch) || epoch <= 0) return '—';
    return new Date(epoch * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  sectionLegend(): Array<{ section: string; color: string; priceLabel: string }> {
    const rows = this.data?.tables ?? [];
    if (!rows.length) return [];

    const sectionPriceMap = new Map<string, number[]>();
    for (const table of rows) {
      const section = String(table.section ?? '').trim().toUpperCase();
      if (!section) continue;
      const price = Number(table.price ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      const list = sectionPriceMap.get(section) ?? [];
      list.push(price);
      sectionPriceMap.set(section, list);
    }

    const sectionColors = this.resolvedSectionColors();
    return Array.from(sectionPriceMap.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((section) => ({
        section,
        color: sectionColors[section] ?? '#94a3b8',
        priceLabel: this.priceLabelForSection(sectionPriceMap.get(section) ?? []),
      }));
  }

  private loadAvailability(eventDate?: string, silent = false): void {
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    this.api.getAvailability(eventDate).subscribe({
      next: (res) => {
        // Most polls return the same data. Re-rendering the 193KB SVG on
        // every tick stalls the main thread on iOS Chrome — enough to
        // stutter the native share/copy menu. Skip the assignment (and
        // therefore the SVG re-parse) when availability is unchanged.
        const changed = !this.isSameAvailability(this.data, res);
        if (changed) {
          this.data = res;
        }
        this.loading = false;
        this.error = null;
        this.syncUrlDate(res.event?.eventDate);
        this.ensurePolling(res.refreshSeconds);
      },
      error: (err) => {
        this.loading = false;
        this.error =
          err?.error?.message || err?.message || 'Unable to load table availability right now.';
      },
    });
  }

  private isSameAvailability(
    prev: PublicAvailabilityResponse | null,
    next: PublicAvailabilityResponse | null
  ): boolean {
    if (!prev || !next) return prev === next;
    if (prev.event?.eventDate !== next.event?.eventDate) return false;
    const a = prev.tables ?? [];
    const b = next.tables ?? [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x.id !== y.id) return false;
      if (x.available !== y.available) return false;
      if (x.price !== y.price) return false;
      if (x.section !== y.section) return false;
    }
    return true;
  }

  private ensurePolling(secondsRaw: number): void {
    const seconds = this.normalizeRefreshSeconds(secondsRaw);
    if (this.pollingSeconds === seconds && this.pollSub) return;
    this.pollingSeconds = seconds;
    this.pollSub?.unsubscribe();
    this.pollSub = interval(seconds * 1000).subscribe(() => {
      // Skip ticks while the tab is hidden — saves polling cycles, and
      // prevents a heavy re-render from landing during the iOS share
      // sheet animation, which can appear as a frozen page.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      this.loadAvailability(this.queryEventDate || undefined, true);
    });
  }

  private normalizeRefreshSeconds(value: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 10;
    return Math.min(60, Math.max(5, Math.round(parsed)));
  }

  private syncUrlDate(eventDate: string | undefined): void {
    const normalized = String(eventDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return;
    if (normalized === this.queryEventDate) return;
    this.queryEventDate = normalized;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { eventDate: normalized },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private compareTableId(a: string, b: string): number {
    const parsedA = this.parseTableId(a);
    const parsedB = this.parseTableId(b);
    if (parsedA.section !== parsedB.section) {
      return parsedA.section.localeCompare(parsedB.section);
    }
    if (parsedA.number !== parsedB.number) {
      return parsedA.number - parsedB.number;
    }
    return a.localeCompare(b);
  }

  private parseTableId(value: string): { section: string; number: number } {
    const text = String(value ?? '').trim().toUpperCase();
    const match = text.match(/^([A-Z]+)(\d{1,4})$/);
    if (!match) return { section: text, number: 0 };
    return {
      section: match[1],
      number: Number(match[2] ?? 0),
    };
  }

  private resolvedSectionColors(): Record<string, string> {
    const custom = this.data?.sectionMapColors ?? {};
    const resolved: Record<string, string> = { ...this.defaultSectionColors };
    for (const [sectionRaw, colorRaw] of Object.entries(custom)) {
      const section = String(sectionRaw ?? '').trim().toUpperCase();
      const color = String(colorRaw ?? '').trim();
      if (!section || !color) continue;
      resolved[section] = color;
    }
    return resolved;
  }

  private priceLabelForSection(values: number[]): string {
    const unique = Array.from(
      new Set(values.filter((value) => Number.isFinite(value) && value > 0))
    ).sort((a, b) => a - b);
    if (!unique.length) return '';
    if (unique.length === 1) return this.formatCurrency(unique[0]);
    return `${this.formatCurrency(unique[0])}+`;
  }

  private formatCurrency(value: number): string {
    return value.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    });
  }
}
