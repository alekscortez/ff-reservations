import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';

// Per-source row from GET /admin/analytics. Returned sorted by
// depositRevenue desc, then visits desc, then source asc so the FE
// just renders top-to-bottom.
export interface AnalyticsRow {
  source: string; // "meta", "google", "(none)" for organic, etc.
  visits: number;
  bookingsStarted: number;
  bookingsPaid: number; // PAID and not CANCELLED — actual won customers
  bookingsCancelled: number;
  depositRevenue: number; // dollars, 2-decimal precision
  // null when visits=0 (legacy bookings without an originating recorded
  // visit — common during the Layer 2 cutover week). Otherwise paid /
  // visits, 4-decimal precision (multiply by 100 to display %).
  conversionRate: number | null;
}

export interface AnalyticsSummary {
  startDate: string;
  endDate: string;
  rows: AnalyticsRow[];
  totals: {
    visits: number;
    bookingsStarted: number;
    bookingsPaid: number;
    depositRevenue: number;
    conversionRate: number | null;
  };
  // Per-day visit counts split by source. { "2026-05-16": { meta: 30, "(none)": 5 } }
  byDate: Record<string, Record<string, number>>;
  generatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private api = inject(ApiClient);

  getSummary(startDate: string, endDate: string) {
    return this.api.get<AnalyticsSummary>(
      `/admin/analytics?startDate=${encodeURIComponent(
        startDate
      )}&endDate=${encodeURIComponent(endDate)}`
    );
  }
}
