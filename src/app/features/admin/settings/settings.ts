import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { AppSettings, SettingsService } from '../../../core/http/settings.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmBadge } from '../../../shared/ui/badge';
import { HlmButton } from '../../../shared/ui/button';
import { HlmCheckbox } from '../../../shared/ui/checkbox';
import { HlmDialog } from '../../../shared/ui/dialog';
import { HlmInput } from '../../../shared/ui/input';
import { HlmNativeSelect } from '../../../shared/ui/native-select';
import { HlmTimePicker } from '../../../shared/ui/time-picker';
import { BrandingManager } from '../branding/branding-manager';

export function joinHm(hour: unknown, minute: unknown, fallback: string): string {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback;
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(m)).padStart(2, '0')}`;
}

export function splitHm(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return { hour: 0, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

type HighImpactKey =
  | 'allowAnonymousPublicBooking'
  | 'allowPastEventPayments'
  | 'auditVerboseLogging';

const HIGH_IMPACT_LABELS: Record<HighImpactKey, string> = {
  allowAnonymousPublicBooking: 'Allow customers to self-book on the public map',
  allowPastEventPayments: 'Allow payments on past events',
  auditVerboseLogging: 'Detailed activity logs (for support)',
};

type SectionKey =
  | 'operations'
  | 'payments'
  | 'liveUpdates'
  | 'checkIn'
  | 'clientMap'
  | 'publicBooking'
  | 'accessAudit';

const FIELD_HINTS: Record<string, { min?: string; max?: string }> = {
  operatingDayCutoffHour: { min: '0 (midnight)', max: '23' },
  holdTtlSeconds: { min: '60 seconds (1 min)', max: '1800 seconds (30 min)' },
  paymentLinkTtlMinutes: { min: '1 minute', max: '120 minutes (2 h)' },
  frequentPaymentLinkTtlMinutes: { min: '10 minutes', max: '10080 minutes (7 d)' },
  dashboardPollingSeconds: { min: '5 seconds', max: '120 seconds (2 min)' },
  tableAvailabilityPollingSeconds: { min: '5 seconds', max: '120 seconds (2 min)' },
  clientAvailabilityPollingSeconds: { min: '5 seconds', max: '120 seconds (2 min)' },
  urgentPaymentWindowMinutes: { min: '5 minutes', max: '1440 minutes (24 h)' },
  checkInPassTtlDays: { min: '1 day', max: '30 days' },
  anonymousHoldTtlSeconds: { min: '300 seconds (5 min)', max: '1800 seconds (30 min)' },
  anonymousMaxTablesPerBooking: { min: '1', max: '10' },
};

const SECTION_CONTROLS: Record<SectionKey, string[]> = {
  operations: ['operatingTz', 'operatingDayCutoffHour', 'holdTtlSeconds'],
  payments: [
    'paymentLinkTtlMinutes',
    'frequentPaymentLinkTtlMinutes',
    'defaultPaymentDeadlineTime',
    'rescheduleCutoffTime',
  ],
  liveUpdates: [
    'dashboardPollingSeconds',
    'tableAvailabilityPollingSeconds',
    'clientAvailabilityPollingSeconds',
    'urgentPaymentWindowMinutes',
  ],
  checkIn: ['checkInPassTtlDays'],
  clientMap: [
    'customerContactPhoneE164',
    'sectionColorA',
    'sectionColorB',
    'sectionColorC',
    'sectionColorD',
    'sectionColorE',
  ],
  publicBooking: ['anonymousHoldTtlSeconds', 'anonymousMaxTablesPerBooking', 'turnstileSiteKey'],
  accessAudit: [],
};

@Component({
  selector: 'app-admin-settings',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    BrandingManager,
    HlmAlert,
    HlmBadge,
    HlmButton,
    HlmCheckbox,
    HlmDialog,
    HlmInput,
    HlmNativeSelect,
    HlmTimePicker,
  ],
  templateUrl: './settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSettings implements OnInit, HasUnsavedChanges {
  private settingsApi = inject(SettingsService);
  private readonly hexColorPattern = /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/;

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly squareEnvMode = signal<'sandbox' | 'production' | null>(null);
  readonly lastSavedAt = signal<number | null>(null);
  readonly pendingConfirm = signal<{ keys: HighImpactKey[] } | null>(null);

  readonly pendingConfirmLabels = computed<string[]>(() => {
    const p = this.pendingConfirm();
    if (!p) return [];
    return p.keys.map((k) => HIGH_IMPACT_LABELS[k]);
  });

  private highImpactSnapshot: Record<HighImpactKey, boolean> = {
    allowAnonymousPublicBooking: false,
    allowPastEventPayments: false,
    auditVerboseLogging: false,
  };

  readonly lastSavedLabel = computed<string | null>(() => {
    const ts = this.lastSavedAt();
    if (!ts) return null;
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Saved at ${hh}:${mm}`;
  });

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
    defaultPaymentDeadlineTime: new FormControl('00:00', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    }),
    rescheduleCutoffTime: new FormControl('22:00', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
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
    // real customer bookings before /reserva UX + Turnstile are ready.
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

  private readonly formStatus = toSignal(
    this.form.statusChanges.pipe(startWith(this.form.status)),
    { initialValue: this.form.status },
  );

  readonly sectionInvalid = computed<Record<SectionKey, boolean>>(() => {
    this.formStatus();
    const out = {} as Record<SectionKey, boolean>;
    for (const section of Object.keys(SECTION_CONTROLS) as SectionKey[]) {
      out[section] = SECTION_CONTROLS[section].some(
        (name) => this.form.get(name)?.invalid === true,
      );
    }
    return out;
  });

  readonly sectionColorRows: ReadonlyArray<{
    key: 'A' | 'B' | 'C' | 'D' | 'E';
    control: FormControl<string>;
    errorKey: string;
  }> = (['A', 'B', 'C', 'D', 'E'] as const).map((key) => ({
    key,
    control: this.form.controls[`sectionColor${key}` as 'sectionColorA'],
    errorKey: `sectionColor${key}`,
  }));

  trackBySectionKey(_index: number, row: { key: string }): string {
    return row.key;
  }

  onColorPick(key: 'A' | 'B' | 'C' | 'D' | 'E', event: Event): void {
    const ctrl = this.form.controls[`sectionColor${key}` as 'sectionColorA'];
    const value = (event.target as HTMLInputElement).value;
    ctrl.setValue(value);
    ctrl.markAsTouched();
    ctrl.markAsDirty();
  }

  squareEnvBadgeVariant(): 'success' | 'warning' | 'destructive' {
    const mode = this.squareEnvMode();
    if (mode === 'production') return 'success';
    if (mode === 'sandbox') return 'warning';
    return 'destructive';
  }

  squareEnvLabel(): string {
    const mode = this.squareEnvMode();
    if (mode === 'production') return 'Live';
    if (mode === 'sandbox') return 'Test';
    return 'Not configured';
  }

  isInvalid(controlName: string): boolean {
    const ctrl = this.form.get(controlName);
    return !!ctrl && ctrl.touched && ctrl.invalid;
  }

  controlError(controlName: string): string | null {
    const ctrl = this.form.get(controlName) as AbstractControl | null;
    if (!ctrl || !ctrl.touched || !ctrl.invalid) return null;
    const errors = ctrl.errors ?? {};
    if (errors['required']) return 'Required';
    const hints = FIELD_HINTS[controlName];
    if (errors['min'] !== undefined) {
      const human = hints?.min ?? String(errors['min'].min);
      return `Must be at least ${human}`;
    }
    if (errors['max'] !== undefined) {
      const human = hints?.max ?? String(errors['max'].max);
      return `Must be at most ${human}`;
    }
    if (errors['pattern']) {
      if (controlName.endsWith('Time')) return 'Use 24-hour HH:MM (e.g. 14:30)';
      return 'Use a color code like #FF0000';
    }
    return 'Please check this value';
  }

  ngOnInit(): void {
    this.load();
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty && !this.saving();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.loadError.set(null);
    this.notice.set(null);
    this.settingsApi.getAdminSettings().subscribe({
      next: (item) => {
        this.applySettings(item);
        this.form.markAsPristine();
        this.loading.set(false);
      },
      error: (err) => {
        const msg = err?.error?.message || err?.message || 'Failed to load settings';
        this.error.set(msg);
        this.loadError.set(msg);
        this.loading.set(false);
      },
    });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const flips = this.detectHighImpactFlips();
    if (flips.length > 0) {
      this.pendingConfirm.set({ keys: flips });
      return;
    }
    this.doSave();
  }

  confirmSave(): void {
    this.pendingConfirm.set(null);
    this.doSave();
  }

  cancelSave(): void {
    this.pendingConfirm.set(null);
  }

  private detectHighImpactFlips(): HighImpactKey[] {
    const out: HighImpactKey[] = [];
    for (const key of Object.keys(HIGH_IMPACT_LABELS) as HighImpactKey[]) {
      const next = Boolean(this.form.controls[key].value);
      if (next && !this.highImpactSnapshot[key]) out.push(key);
    }
    return out;
  }

  private doSave(): void {
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);

    this.settingsApi.updateAdminSettings(this.toPatch()).subscribe({
      next: (item) => {
        this.applySettings(item);
        this.saving.set(false);
        this.notice.set('Settings saved.');
        this.lastSavedAt.set(Date.now());
        this.form.markAsPristine();
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
      defaultPaymentDeadlineTime: joinHm(item.defaultPaymentDeadlineHour, item.defaultPaymentDeadlineMinute, '00:00'),
      rescheduleCutoffTime: joinHm(item.rescheduleCutoffHour, item.rescheduleCutoffMinute, '22:00'),
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
    this.highImpactSnapshot = {
      allowAnonymousPublicBooking: Boolean(item.allowAnonymousPublicBooking),
      allowPastEventPayments: Boolean(item.allowPastEventPayments),
      auditVerboseLogging: Boolean(item.auditVerboseLogging),
    };
  }

  private toPatch(): Partial<AppSettings> {
    const deadline = splitHm(this.form.controls.defaultPaymentDeadlineTime.value);
    const reschedule = splitHm(this.form.controls.rescheduleCutoffTime.value);
    return {
      operatingTz: this.form.controls.operatingTz.value.trim(),
      operatingDayCutoffHour: Number(this.form.controls.operatingDayCutoffHour.value),
      holdTtlSeconds: Number(this.form.controls.holdTtlSeconds.value),
      cashReceiptNumberRequired: Boolean(this.form.controls.cashReceiptNumberRequired.value),
      paymentLinkTtlMinutes: Number(this.form.controls.paymentLinkTtlMinutes.value),
      frequentPaymentLinkTtlMinutes: Number(this.form.controls.frequentPaymentLinkTtlMinutes.value),
      autoSendSquareLinkSms: Boolean(this.form.controls.autoSendSquareLinkSms.value),
      smsEnabled: Boolean(this.form.controls.smsEnabled.value),
      defaultPaymentDeadlineHour: deadline.hour,
      defaultPaymentDeadlineMinute: deadline.minute,
      rescheduleCutoffHour: reschedule.hour,
      rescheduleCutoffMinute: reschedule.minute,
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
