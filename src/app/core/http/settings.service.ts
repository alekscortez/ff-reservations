import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export interface SectionMapColors {
  A: string;
  B: string;
  C: string;
  D: string;
  E: string;
}

export interface AppSettings {
  operatingTz: string;
  operatingDayCutoffHour: number;
  holdTtlSeconds: number;
  paymentLinkTtlMinutes: number;
  frequentPaymentLinkTtlMinutes: number;
  autoSendSquareLinkSms: boolean;
  smsEnabled: boolean;
  defaultPaymentDeadlineHour: number;
  defaultPaymentDeadlineMinute: number;
  rescheduleCutoffHour: number;
  rescheduleCutoffMinute: number;
  allowPastEventEdits: boolean;
  allowPastEventPayments: boolean;
  dashboardPollingSeconds: number;
  tableAvailabilityPollingSeconds: number;
  clientAvailabilityPollingSeconds: number;
  urgentPaymentWindowMinutes: number;
  maxReservationsPerPhonePerEvent: number;
  maxPendingWindowMinutes: number;
  checkInPassTtlDays: number;
  checkInPassBaseUrl: string;
  showClientFacingMap: boolean;
  auditVerboseLogging: boolean;
  squareEnvMode: 'sandbox' | 'production';
  sectionMapColors: SectionMapColors;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private api = inject(ApiClient);

  getAdminSettings() {
    return this.api.get<{ item: AppSettings }>('/admin/settings').pipe(
      map((res) => res.item)
    );
  }

  updateAdminSettings(patch: Partial<AppSettings>) {
    return this.api.put<{ item: AppSettings }>('/admin/settings', patch).pipe(
      map((res) => res.item)
    );
  }
}
