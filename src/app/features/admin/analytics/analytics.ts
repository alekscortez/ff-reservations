import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  AnalyticsService,
  AnalyticsSummary,
} from '../../../core/http/analytics.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmBadge } from '../../../shared/ui/badge';
import { HlmDateRangePicker } from '../../../shared/ui/date-picker';

interface RangePreset {
  label: string;
  days: number;
}

const PRESETS: RangePreset[] = [
  { label: 'Today', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

@Component({
  selector: 'app-admin-analytics',
  standalone: true,
  imports: [
    CommonModule,
    HlmAlert,
    HlmButton,
    HlmBadge,
    HlmDateRangePicker,
  ],
  templateUrl: './analytics.html',
  styleUrl: './analytics.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminAnalytics implements OnInit {
  private api = inject(AnalyticsService);
  private destroyRef = inject(DestroyRef);

  readonly presets = PRESETS;
  readonly activePreset = signal<number | null>(7);

  // Date range — defaults to last 7 days inclusive of today.
  readonly startDate = signal(this.daysAgoIsoUtc(6));
  readonly endDate = signal(this.todayIsoUtc());

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly summary = signal<AnalyticsSummary | null>(null);

  // Derived KPIs — pulled from totals on the response. Empty-state safe.
  readonly visits = computed(() => this.summary()?.totals.visits ?? 0);
  readonly bookingsPaid = computed(() => this.summary()?.totals.bookingsPaid ?? 0);
  readonly bookingsStarted = computed(
    () => this.summary()?.totals.bookingsStarted ?? 0
  );
  readonly revenue = computed(() => this.summary()?.totals.depositRevenue ?? 0);
  readonly conversion = computed(() => this.summary()?.totals.conversionRate ?? null);

  // Bridge between HlmDateRangePicker's Date model and our ISO strings.
  // Keep a single Date pair as the picker's signal; refetch on commit.
  readonly rangeFrom = signal<Date | undefined>(this.daysAgoDateUtc(6));
  readonly rangeTo = signal<Date | undefined>(this.todayDateUtc());

  ngOnInit(): void {
    this.refresh();
  }

  applyPreset(p: RangePreset): void {
    this.activePreset.set(p.days);
    const end = this.todayIsoUtc();
    const start = this.daysAgoIsoUtc(p.days - 1);
    this.startDate.set(start);
    this.endDate.set(end);
    this.rangeFrom.set(this.daysAgoDateUtc(p.days - 1));
    this.rangeTo.set(this.todayDateUtc());
    this.refresh();
  }

  onRangeCommit(): void {
    const from = this.rangeFrom();
    const to = this.rangeTo();
    if (!from || !to) return;
    this.activePreset.set(null);
    this.startDate.set(this.toIsoUtc(from));
    this.endDate.set(this.toIsoUtc(to));
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .getSummary(this.startDate(), this.endDate())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.summary.set(s);
          this.loading.set(false);
        },
        error: (err) => {
          const message =
            err?.error?.message ??
            err?.message ??
            'Failed to load analytics. Try again in a moment.';
          this.error.set(String(message));
          this.loading.set(false);
        },
      });
  }

  // Display helpers — keep template terse.
  formatConversion(rate: number | null): string {
    if (rate === null || !Number.isFinite(rate)) return '—';
    return `${(rate * 100).toFixed(1)}%`;
  }

  formatSource(source: string): string {
    if (source === '(none)') return 'Direct / Organic';
    return source.charAt(0).toUpperCase() + source.slice(1);
  }

  trackRow(_index: number, row: { source: string }): string {
    return row.source;
  }

  // ── Date helpers (UTC, YYYY-MM-DD) ──────────────────────────────────
  private todayIsoUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private daysAgoIsoUtc(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  private todayDateUtc(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  }

  private daysAgoDateUtc(days: number): Date {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private toIsoUtc(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
