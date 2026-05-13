import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import {
  PublicAvailabilityResponse,
  PublicAvailabilityService,
  PublicAvailabilityTable,
} from '../../../core/http/public-availability.service';
import { TableMap } from '../../../shared/components/table-map/table-map';
import { TableForEvent } from '../../../shared/models/table.model';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';
import { HlmToggle } from '../../../shared/ui/toggle';

interface PublicAvailabilityPickerOption {
  eventDate: string;
  label: string;
}

@Component({
  selector: 'app-public-availability',
  imports: [CommonModule, ReactiveFormsModule, TableMap, HlmAlert, HlmButton, HlmInput, HlmToggle],
  templateUrl: './availability.html',
  styleUrl: './availability.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicAvailability implements OnInit, OnDestroy {
  private api = inject(PublicAvailabilityService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private titleService = inject(Title);
  private metaService = inject(Meta);
  private readonly defaultSectionColors: Record<string, string> = {
    A: '#ec008c',
    B: '#2e3192',
    C: '#00aeef',
    D: '#f7941d',
    E: '#711411',
  };

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<PublicAvailabilityResponse | null>(null);

  viewMode = new FormControl<'MAP' | 'LIST'>('MAP', { nonNullable: true });
  search = new FormControl('', { nonNullable: true });
  availableOnly = new FormControl(true, { nonNullable: true });

  // Form-control values as signals so the computed lists below stay
  // reactive without manual recompute.
  private readonly searchSignal = toSignal(this.search.valueChanges, {
    initialValue: this.search.value,
  });
  private readonly availableOnlySignal = toSignal(this.availableOnly.valueChanges, {
    initialValue: this.availableOnly.value,
  });

  private pollSub: Subscription | null = null;
  private pollingSeconds = 0;
  private currentLoadSub: Subscription | null = null;
  private queryEventDate = '';

  ngOnInit(): void {
    this.titleService.setTitle('Famoso Fuego — Live Table Availability');
    this.metaService.updateTag({
      name: 'description',
      content:
        'See which tables are open tonight at Famoso Fuego. Live availability updates every few seconds.',
    });
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
    this.currentLoadSub?.unsubscribe();
    this.currentLoadSub = null;
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

  retryLoad(): void {
    this.loadAvailability(this.queryEventDate || undefined);
  }

  clearFilters(): void {
    this.search.setValue('');
    this.availableOnly.setValue(false);
  }

  // Memoized derivations of `data` + form-control filters. Computed
  // signals re-evaluate only when their inputs change instead of on
  // every CD cycle, so the template can keep its invocation-form
  // bindings (`filteredTables()`, `mapTables()`, `sectionLegend()`).
  readonly filteredTables = computed<PublicAvailabilityTable[]>(() => {
    const rows = this.data()?.tables ?? [];
    const query = (this.searchSignal() ?? '').trim().toLowerCase();
    const availableOnly = this.availableOnlySignal() ?? true;
    return rows
      .filter((item) => (availableOnly ? item.available : true))
      .filter((item) => (query ? item.id.toLowerCase().includes(query) : true))
      .sort((a, b) => this.compareTableId(a.id, b.id));
  });

  readonly mapTables = computed<TableForEvent[]>(() => {
    const source = this.data()?.tables ?? [];
    return source.map((item) => ({
      id: item.id,
      number: item.number,
      section: item.section,
      price: item.price,
      status: item.available ? 'AVAILABLE' : 'DISABLED',
      disabled: !item.available,
    }));
  });

  readonly hasNoFilteredTables = computed<boolean>(
    () => this.filteredTables().length === 0
  );

  readonly hasActiveFilter = computed<boolean>(() => {
    const query = (this.searchSignal() ?? '').trim();
    const availableOnly = this.availableOnlySignal() ?? true;
    return query.length > 0 || availableOnly;
  });

  readonly pickerOptions = computed<PublicAvailabilityPickerOption[]>(() => {
    const events = this.data()?.events ?? [];
    return events.map((item) => ({
      eventDate: item.eventDate,
      label: this.formatPickerLabel(item.eventDate, item.eventName),
    }));
  });

  // E.164 phone (or empty). Public response carries it when the admin has
  // configured `customerContactPhoneE164`; we render Call + WhatsApp CTAs
  // when present, hide the block otherwise.
  readonly contactPhone = computed<string>(() => {
    return String(this.data()?.customerContactPhoneE164 ?? '').trim();
  });

  readonly telHref = computed<string>(() => {
    const phone = this.contactPhone();
    return phone ? `tel:${phone}` : '';
  });

  readonly whatsappHref = computed<string>(() => {
    const phone = this.contactPhone();
    if (!phone) return '';
    // wa.me wants the digits only (no leading +).
    const digits = phone.replace(/[^\d]/g, '');
    return digits ? `https://wa.me/${digits}` : '';
  });

  trackEventDate(_index: number, item: PublicAvailabilityPickerOption): string {
    return item.eventDate;
  }

  private formatPickerLabel(eventDate: string, eventName: string): string {
    const parsed = new Date(`${eventDate}T00:00:00`);
    const datePart = Number.isNaN(parsed.getTime())
      ? eventDate
      : parsed.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
    const name = String(eventName ?? '').trim();
    return name ? `${datePart} · ${name}` : datePart;
  }

  asOfLabel(): string {
    const epoch = Number(this.data()?.asOfEpoch ?? 0);
    if (!Number.isFinite(epoch) || epoch <= 0) return '—';
    return new Date(epoch * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  readonly sectionLegend = computed<Array<{ section: string; color: string; priceLabel: string }>>(() => {
    const rows = this.data()?.tables ?? [];
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
  });

  private loadAvailability(eventDate?: string, silent = false): void {
    // Cancel any in-flight load. Without this, rapid date toggles can
    // resolve out-of-order and the slower (older) response wins.
    this.currentLoadSub?.unsubscribe();
    this.currentLoadSub = null;

    if (!silent) {
      this.loading.set(true);
      this.error.set(null);
    }
    this.currentLoadSub = this.api.getAvailability(eventDate).subscribe({
      next: (res) => {
        // Most polls return the same data. Re-rendering the 193KB SVG on
        // every tick stalls the main thread on iOS Chrome — enough to
        // stutter the native share/copy menu. Skip the assignment (and
        // therefore the SVG re-parse) when availability is unchanged.
        const changed = !this.isSameAvailability(this.data(), res);
        if (changed) {
          this.data.set(res);
        }
        this.loading.set(false);
        this.error.set(null);
        this.syncUrlDate(res.event?.eventDate);
        this.ensurePolling(res.refreshSeconds);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(
          err?.error?.message || err?.message || 'Unable to load table availability right now.'
        );
        // Keep polling even after a failure so transient errors recover
        // on their own. First-call errors land here with `pollingSeconds`
        // still 0; fall back to 10s.
        this.ensurePolling(this.pollingSeconds || 10);
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
    const custom = this.data()?.sectionMapColors ?? {};
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
