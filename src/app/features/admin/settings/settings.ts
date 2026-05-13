import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AppSettings, SettingsService } from '../../../core/http/settings.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';

@Component({
  selector: 'app-admin-settings',
  imports: [CommonModule, ReactiveFormsModule, HlmAlert, HlmButton, HlmInput],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSettings implements OnInit {
  private settingsApi = inject(SettingsService);
  private readonly hexColorPattern = /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/;

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly squareEnvMode = signal<'sandbox' | 'production' | null>(null);

  form = new FormGroup({
    operatingTz: new FormControl('America/Chicago', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    operatingDayCutoffHour: new FormControl(5, {
      nonNullable: true,
      validators: [Validators.min(0), Validators.max(23)],
    }),
    holdTtlSeconds: new FormControl(300, {
      nonNullable: true,
      validators: [Validators.min(60), Validators.max(1800)],
    }),
    cashReceiptNumberRequired: new FormControl(true, { nonNullable: true }),
    paymentLinkTtlMinutes: new FormControl(10, {
      nonNullable: true,
      validators: [Validators.min(1), Validators.max(120)],
    }),
    frequentPaymentLinkTtlMinutes: new FormControl(1440, {
      nonNullable: true,
      validators: [Validators.min(10), Validators.max(10080)],
    }),
    autoSendSquareLinkSms: new FormControl(false, { nonNullable: true }),
    smsEnabled: new FormControl(true, { nonNullable: true }),
    defaultPaymentDeadlineHour: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.min(0), Validators.max(23)],
    }),
    defaultPaymentDeadlineMinute: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.min(0), Validators.max(59)],
    }),
    rescheduleCutoffHour: new FormControl(22, {
      nonNullable: true,
      validators: [Validators.min(0), Validators.max(23)],
    }),
    rescheduleCutoffMinute: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.min(0), Validators.max(59)],
    }),
    dashboardPollingSeconds: new FormControl(15, {
      nonNullable: true,
      validators: [Validators.min(5), Validators.max(120)],
    }),
    tableAvailabilityPollingSeconds: new FormControl(10, {
      nonNullable: true,
      validators: [Validators.min(5), Validators.max(120)],
    }),
    clientAvailabilityPollingSeconds: new FormControl(15, {
      nonNullable: true,
      validators: [Validators.min(5), Validators.max(120)],
    }),
    urgentPaymentWindowMinutes: new FormControl(360, {
      nonNullable: true,
      validators: [Validators.min(5), Validators.max(1440)],
    }),
    checkInPassTtlDays: new FormControl(2, {
      nonNullable: true,
      validators: [Validators.min(1), Validators.max(30)],
    }),
    sectionColorA: new FormControl('#ec008c', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(this.hexColorPattern)],
    }),
    sectionColorB: new FormControl('#2e3192', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(this.hexColorPattern)],
    }),
    sectionColorC: new FormControl('#00aeef', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(this.hexColorPattern)],
    }),
    sectionColorD: new FormControl('#f7941d', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(this.hexColorPattern)],
    }),
    sectionColorE: new FormControl('#711411', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(this.hexColorPattern)],
    }),
    showClientFacingMap: new FormControl(false, { nonNullable: true }),
    // Free-form on the client — backend normalizes US/MX formats and
    // rejects unparseable input with a clear 400 message.
    customerContactPhoneE164: new FormControl('', { nonNullable: true }),
    // Anonymous public booking — gates everything off until flipped on.
    // Default false so a fresh deploy can't accidentally start taking
    // real customer bookings before /map UX + Turnstile are ready.
    allowAnonymousPublicBooking: new FormControl(false, { nonNullable: true }),
    anonymousHoldTtlSeconds: new FormControl(600, {
      nonNullable: true,
      validators: [Validators.min(300), Validators.max(1800)],
    }),
    anonymousMaxTablesPerBooking: new FormControl(4, {
      nonNullable: true,
      validators: [Validators.min(1), Validators.max(10)],
    }),
    turnstileSiteKey: new FormControl('', { nonNullable: true }),
    allowPastEventEdits: new FormControl(false, { nonNullable: true }),
    allowPastEventPayments: new FormControl(false, { nonNullable: true }),
    auditVerboseLogging: new FormControl(false, { nonNullable: true }),
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.settingsApi.getAdminSettings().subscribe({
      next: (item) => {
        this.applySettings(item);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load settings');
        this.loading.set(false);
      },
    });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);

    this.settingsApi.updateAdminSettings(this.toPatch()).subscribe({
      next: (item) => {
        this.applySettings(item);
        this.saving.set(false);
        this.notice.set('Settings saved.');
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to save settings');
        this.saving.set(false);
      },
    });
  }

  private applySettings(item: AppSettings): void {
    this.form.patchValue({
      operatingTz: item.operatingTz ?? 'America/Chicago',
      operatingDayCutoffHour: Number(item.operatingDayCutoffHour ?? 5),
      holdTtlSeconds: Number(item.holdTtlSeconds ?? 300),
      cashReceiptNumberRequired: Boolean(item.cashReceiptNumberRequired ?? true),
      paymentLinkTtlMinutes: Number(item.paymentLinkTtlMinutes ?? 10),
      frequentPaymentLinkTtlMinutes: Number(item.frequentPaymentLinkTtlMinutes ?? 1440),
      autoSendSquareLinkSms: Boolean(item.autoSendSquareLinkSms),
      smsEnabled: Boolean(item.smsEnabled),
      defaultPaymentDeadlineHour: Number(item.defaultPaymentDeadlineHour ?? 0),
      defaultPaymentDeadlineMinute: Number(item.defaultPaymentDeadlineMinute ?? 0),
      rescheduleCutoffHour: Number(item.rescheduleCutoffHour ?? 22),
      rescheduleCutoffMinute: Number(item.rescheduleCutoffMinute ?? 0),
      dashboardPollingSeconds: Number(item.dashboardPollingSeconds ?? 15),
      tableAvailabilityPollingSeconds: Number(item.tableAvailabilityPollingSeconds ?? 10),
      clientAvailabilityPollingSeconds: Number(item.clientAvailabilityPollingSeconds ?? 15),
      urgentPaymentWindowMinutes: Number(item.urgentPaymentWindowMinutes ?? 360),
      checkInPassTtlDays: Number(item.checkInPassTtlDays ?? 2),
      sectionColorA: String(item.sectionMapColors?.A ?? '#ec008c').trim().toLowerCase(),
      sectionColorB: String(item.sectionMapColors?.B ?? '#2e3192').trim().toLowerCase(),
      sectionColorC: String(item.sectionMapColors?.C ?? '#00aeef').trim().toLowerCase(),
      sectionColorD: String(item.sectionMapColors?.D ?? '#f7941d').trim().toLowerCase(),
      sectionColorE: String(item.sectionMapColors?.E ?? '#711411').trim().toLowerCase(),
      showClientFacingMap: Boolean(item.showClientFacingMap),
      customerContactPhoneE164: String(item.customerContactPhoneE164 ?? '').trim(),
      allowAnonymousPublicBooking: Boolean(item.allowAnonymousPublicBooking),
      anonymousHoldTtlSeconds: Number(item.anonymousHoldTtlSeconds ?? 600),
      anonymousMaxTablesPerBooking: Number(item.anonymousMaxTablesPerBooking ?? 4),
      turnstileSiteKey: String(item.turnstileSiteKey ?? '').trim(),
      allowPastEventEdits: Boolean(item.allowPastEventEdits),
      allowPastEventPayments: Boolean(item.allowPastEventPayments),
      auditVerboseLogging: Boolean(item.auditVerboseLogging),
    });
    this.squareEnvMode.set(item.squareEnvMode ?? null);
  }

  private toPatch(): Partial<AppSettings> {
    return {
      operatingTz: this.form.controls.operatingTz.value.trim(),
      operatingDayCutoffHour: Number(this.form.controls.operatingDayCutoffHour.value),
      holdTtlSeconds: Number(this.form.controls.holdTtlSeconds.value),
      cashReceiptNumberRequired: Boolean(this.form.controls.cashReceiptNumberRequired.value),
      paymentLinkTtlMinutes: Number(this.form.controls.paymentLinkTtlMinutes.value),
      frequentPaymentLinkTtlMinutes: Number(this.form.controls.frequentPaymentLinkTtlMinutes.value),
      autoSendSquareLinkSms: Boolean(this.form.controls.autoSendSquareLinkSms.value),
      smsEnabled: Boolean(this.form.controls.smsEnabled.value),
      defaultPaymentDeadlineHour: Number(this.form.controls.defaultPaymentDeadlineHour.value),
      defaultPaymentDeadlineMinute: Number(this.form.controls.defaultPaymentDeadlineMinute.value),
      rescheduleCutoffHour: Number(this.form.controls.rescheduleCutoffHour.value),
      rescheduleCutoffMinute: Number(this.form.controls.rescheduleCutoffMinute.value),
      dashboardPollingSeconds: Number(this.form.controls.dashboardPollingSeconds.value),
      tableAvailabilityPollingSeconds: Number(this.form.controls.tableAvailabilityPollingSeconds.value),
      clientAvailabilityPollingSeconds: Number(this.form.controls.clientAvailabilityPollingSeconds.value),
      urgentPaymentWindowMinutes: Number(this.form.controls.urgentPaymentWindowMinutes.value),
      checkInPassTtlDays: Number(this.form.controls.checkInPassTtlDays.value),
      sectionMapColors: {
        A: this.form.controls.sectionColorA.value.trim().toLowerCase(),
        B: this.form.controls.sectionColorB.value.trim().toLowerCase(),
        C: this.form.controls.sectionColorC.value.trim().toLowerCase(),
        D: this.form.controls.sectionColorD.value.trim().toLowerCase(),
        E: this.form.controls.sectionColorE.value.trim().toLowerCase(),
      },
      showClientFacingMap: Boolean(this.form.controls.showClientFacingMap.value),
      customerContactPhoneE164: this.form.controls.customerContactPhoneE164.value.trim(),
      allowAnonymousPublicBooking: Boolean(
        this.form.controls.allowAnonymousPublicBooking.value
      ),
      anonymousHoldTtlSeconds: Number(
        this.form.controls.anonymousHoldTtlSeconds.value
      ),
      anonymousMaxTablesPerBooking: Number(
        this.form.controls.anonymousMaxTablesPerBooking.value
      ),
      turnstileSiteKey: this.form.controls.turnstileSiteKey.value.trim(),
      allowPastEventEdits: Boolean(this.form.controls.allowPastEventEdits.value),
      allowPastEventPayments: Boolean(this.form.controls.allowPastEventPayments.value),
      auditVerboseLogging: Boolean(this.form.controls.auditVerboseLogging.value),
    };
  }
}
