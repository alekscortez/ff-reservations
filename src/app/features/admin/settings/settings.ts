import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AppSettings, SettingsService } from '../../../core/http/settings.service';

@Component({
  selector: 'app-admin-settings',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class AdminSettings implements OnInit {
  private settingsApi = inject(SettingsService);
  private readonly hexColorPattern = /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/;

  loading = false;
  saving = false;
  error: string | null = null;
  notice: string | null = null;
  squareEnvMode: 'sandbox' | 'production' | null = null;

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
    paymentLinkTtlMinutes: new FormControl(10, {
      nonNullable: true,
      validators: [Validators.min(1), Validators.max(120)],
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
    allowPastEventEdits: new FormControl(false, { nonNullable: true }),
    allowPastEventPayments: new FormControl(false, { nonNullable: true }),
    auditVerboseLogging: new FormControl(false, { nonNullable: true }),
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.settingsApi.getAdminSettings().subscribe({
      next: (item) => {
        this.applySettings(item);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load settings';
        this.loading = false;
      },
    });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving = true;
    this.error = null;
    this.notice = null;

    this.settingsApi.updateAdminSettings(this.toPatch()).subscribe({
      next: (item) => {
        this.applySettings(item);
        this.saving = false;
        this.notice = 'Settings saved.';
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to save settings';
        this.saving = false;
      },
    });
  }

  private applySettings(item: AppSettings): void {
    this.form.patchValue({
      operatingTz: item.operatingTz ?? 'America/Chicago',
      operatingDayCutoffHour: Number(item.operatingDayCutoffHour ?? 5),
      holdTtlSeconds: Number(item.holdTtlSeconds ?? 300),
      paymentLinkTtlMinutes: Number(item.paymentLinkTtlMinutes ?? 10),
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
      allowPastEventEdits: Boolean(item.allowPastEventEdits),
      allowPastEventPayments: Boolean(item.allowPastEventPayments),
      auditVerboseLogging: Boolean(item.auditVerboseLogging),
    });
    this.squareEnvMode = item.squareEnvMode ?? null;
  }

  private toPatch(): Partial<AppSettings> {
    return {
      operatingTz: this.form.controls.operatingTz.value.trim(),
      operatingDayCutoffHour: Number(this.form.controls.operatingDayCutoffHour.value),
      holdTtlSeconds: Number(this.form.controls.holdTtlSeconds.value),
      paymentLinkTtlMinutes: Number(this.form.controls.paymentLinkTtlMinutes.value),
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
      allowPastEventEdits: Boolean(this.form.controls.allowPastEventEdits.value),
      allowPastEventPayments: Boolean(this.form.controls.allowPastEventPayments.value),
      auditVerboseLogging: Boolean(this.form.controls.auditVerboseLogging.value),
    };
  }
}
