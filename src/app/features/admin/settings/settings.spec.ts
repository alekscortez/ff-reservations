import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';

import { SettingsService } from '../../../core/http/settings.service';
import { AdminSettings, joinHm, splitHm } from './settings';

function fullDefaults() {
  return {
    operatingTz: 'America/Chicago',
    operatingDayCutoffHour: 5,
    holdTtlSeconds: 300,
    cashReceiptNumberRequired: true,
    paymentLinkTtlMinutes: 10,
    frequentPaymentLinkTtlMinutes: 1440,
    autoSendSquareLinkSms: false,
    smsEnabled: true,
    defaultPaymentDeadlineHour: 0,
    defaultPaymentDeadlineMinute: 0,
    rescheduleCutoffHour: 22,
    rescheduleCutoffMinute: 0,
    allowPastEventEdits: false,
    allowPastEventPayments: false,
    dashboardPollingSeconds: 15,
    tableAvailabilityPollingSeconds: 10,
    clientAvailabilityPollingSeconds: 15,
    urgentPaymentWindowMinutes: 360,
    checkInPassTtlDays: 2,
    showClientFacingMap: false,
    customerContactPhoneE164: '',
    allowAnonymousPublicBooking: false,
    anonymousHoldTtlSeconds: 600,
    anonymousMaxTablesPerBooking: 4,
    turnstileSiteKey: '',
    auditVerboseLogging: false,
    squareEnvMode: 'sandbox' as const,
    sectionMapColors: {
      A: '#ec008c',
      B: '#2e3192',
      C: '#00aeef',
      D: '#f7941d',
      E: '#711411',
    },
  };
}

describe('AdminSettings', () => {
  let fixture: ComponentFixture<AdminSettings>;
  let component: AdminSettings;
  let getSpy: ReturnType<typeof vi.fn>;
  let putSpy: ReturnType<typeof vi.fn>;

  function setup(loadResponse = of(fullDefaults() as any)) {
    getSpy = vi.fn().mockReturnValue(loadResponse);
    putSpy = vi.fn().mockReturnValue(of(fullDefaults() as any));
    TestBed.configureTestingModule({
      imports: [AdminSettings],
      providers: [
        {
          provide: SettingsService,
          useValue: { getAdminSettings: getSpy, updateAdminSettings: putSpy },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminSettings);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  it('creates and loads defaults', () => {
    setup();
    expect(component).toBeTruthy();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(component.form.valid).toBe(true);
    expect(component.form.controls.operatingTz.value).toBe('America/Chicago');
    expect(component.form.controls.sectionColorA.value).toBe('#ec008c');
    expect(component.squareEnvMode()).toBe('sandbox');
  });

  it('joinHm: combines hour + minute into HH:MM with padding', () => {
    expect(joinHm(0, 0, 'fb')).toBe('00:00');
    expect(joinHm(9, 5, 'fb')).toBe('09:05');
    expect(joinHm(23, 59, 'fb')).toBe('23:59');
  });

  it('joinHm: returns fallback when out of range or non-numeric', () => {
    expect(joinHm(24, 0, '00:00')).toBe('00:00');
    expect(joinHm(-1, 0, '00:00')).toBe('00:00');
    expect(joinHm(10, 60, '00:00')).toBe('00:00');
    expect(joinHm('x' as any, 0, '00:00')).toBe('00:00');
    expect(joinHm(undefined, undefined, '22:00')).toBe('22:00');
  });

  it('splitHm: parses HH:MM into integers', () => {
    expect(splitHm('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(splitHm('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(splitHm('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('splitHm: returns 0,0 on bad input', () => {
    expect(splitHm('not a time')).toEqual({ hour: 0, minute: 0 });
    expect(splitHm('25:00')).toEqual({ hour: 0, minute: 0 });
    expect(splitHm('')).toEqual({ hour: 0, minute: 0 });
  });

  it('applySettings: hour+minute -> HH:MM in form', () => {
    setup(of({ ...fullDefaults(), defaultPaymentDeadlineHour: 14, defaultPaymentDeadlineMinute: 30, rescheduleCutoffHour: 23, rescheduleCutoffMinute: 45 } as any));
    expect(component.form.controls.defaultPaymentDeadlineTime.value).toBe('14:30');
    expect(component.form.controls.rescheduleCutoffTime.value).toBe('23:45');
  });

  it('toPatch: HH:MM -> hour+minute on the wire', () => {
    setup();
    component.form.controls.defaultPaymentDeadlineTime.setValue('14:30');
    component.form.controls.rescheduleCutoffTime.setValue('23:45');
    component.form.controls.defaultPaymentDeadlineTime.markAsDirty();
    component.save();
    const patch = putSpy.mock.calls[0][0];
    expect(patch.defaultPaymentDeadlineHour).toBe(14);
    expect(patch.defaultPaymentDeadlineMinute).toBe(30);
    expect(patch.rescheduleCutoffHour).toBe(23);
    expect(patch.rescheduleCutoffMinute).toBe(45);
  });

  it('controlError: time pattern message', () => {
    setup();
    component.form.controls.defaultPaymentDeadlineTime.setValue('99:99');
    component.form.controls.defaultPaymentDeadlineTime.markAsTouched();
    expect(component.controlError('defaultPaymentDeadlineTime')).toBe(
      'Use 24-hour HH:MM (e.g. 14:30)',
    );
  });

  it('starts pristine after load', () => {
    setup();
    expect(component.form.dirty).toBe(false);
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  it('applySettings round-trip preserves all keys via toPatch', () => {
    setup();
    // dirty a few values
    component.form.patchValue({ operatingTz: 'America/Mexico_City', holdTtlSeconds: 600 });
    component.save();
    expect(putSpy).toHaveBeenCalledTimes(1);
    const patch = putSpy.mock.calls[0][0];
    expect(patch.operatingTz).toBe('America/Mexico_City');
    expect(patch.holdTtlSeconds).toBe(600);
    expect(patch.sectionMapColors).toEqual({
      A: '#ec008c',
      B: '#2e3192',
      C: '#00aeef',
      D: '#f7941d',
      E: '#711411',
    });
  });

  it('sectionMapColors lowercased on patch', () => {
    setup();
    component.form.controls.sectionColorA.setValue('#ABCDEF');
    component.save();
    const patch = putSpy.mock.calls[0][0];
    expect(patch.sectionMapColors.A).toBe('#abcdef');
  });

  it('boolean controls coerce to true/false on patch', () => {
    setup();
    component.form.controls.smsEnabled.setValue(false);
    component.form.controls.autoSendSquareLinkSms.setValue(true);
    component.save();
    const patch = putSpy.mock.calls[0][0];
    expect(patch.smsEnabled).toBe(false);
    expect(patch.autoSendSquareLinkSms).toBe(true);
  });

  it('save: invalid form does not call API; controls marked touched', () => {
    setup();
    component.form.controls.operatingTz.setValue('');
    expect(component.form.invalid).toBe(true);
    component.save();
    expect(putSpy).not.toHaveBeenCalled();
    expect(component.form.controls.operatingTz.touched).toBe(true);
  });

  it('save success sets lastSavedAt + notice + clears dirty', () => {
    setup();
    component.form.controls.holdTtlSeconds.setValue(600);
    component.form.controls.holdTtlSeconds.markAsDirty();
    expect(component.form.dirty).toBe(true);
    component.save();
    expect(component.lastSavedAt()).not.toBeNull();
    expect(component.notice()).toBe('Settings saved.');
    expect(component.form.dirty).toBe(false);
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  it('save error surfaces error signal; saving=false; form stays dirty', () => {
    setup();
    putSpy.mockReturnValueOnce(throwError(() => ({ error: { message: 'nope' } })));
    component.form.controls.holdTtlSeconds.setValue(600);
    component.form.controls.holdTtlSeconds.markAsDirty();
    component.save();
    expect(component.error()).toBe('nope');
    expect(component.saving()).toBe(false);
    expect(component.form.dirty).toBe(true);
  });

  it('load error surfaces error + loadError signals; loading=false', () => {
    setup(throwError(() => ({ message: 'fail load' })));
    expect(component.error()).toBe('fail load');
    expect(component.loadError()).toBe('fail load');
    expect(component.loading()).toBe(false);
  });

  it('save error does NOT set loadError', () => {
    setup();
    putSpy.mockReturnValueOnce(throwError(() => ({ error: { message: 'nope' } })));
    component.form.controls.holdTtlSeconds.setValue(600);
    component.form.controls.holdTtlSeconds.markAsDirty();
    component.save();
    expect(component.error()).toBe('nope');
    expect(component.loadError()).toBeNull();
  });

  it('isInvalid: returns true only when control is touched + invalid', () => {
    setup();
    expect(component.isInvalid('holdTtlSeconds')).toBe(false);
    component.form.controls.holdTtlSeconds.setValue(30);
    expect(component.isInvalid('holdTtlSeconds')).toBe(false);
    component.form.controls.holdTtlSeconds.markAsTouched();
    expect(component.isInvalid('holdTtlSeconds')).toBe(true);
  });

  it('controlError: null when control is valid', () => {
    setup();
    expect(component.controlError('operatingTz')).toBeNull();
  });

  it('controlError: Required when required validator fails + touched', () => {
    setup();
    component.form.controls.operatingTz.setValue('');
    component.form.controls.operatingTz.markAsTouched();
    expect(component.controlError('operatingTz')).toBe('Required');
  });

  it('controlError: friendly min message includes unit + readable suffix', () => {
    setup();
    component.form.controls.holdTtlSeconds.setValue(30);
    component.form.controls.holdTtlSeconds.markAsTouched();
    expect(component.controlError('holdTtlSeconds')).toBe('Must be at least 60 seconds (1 min)');
  });

  it('controlError: friendly max message includes unit + readable suffix', () => {
    setup();
    component.form.controls.urgentPaymentWindowMinutes.setValue(99999);
    component.form.controls.urgentPaymentWindowMinutes.markAsTouched();
    expect(component.controlError('urgentPaymentWindowMinutes')).toBe(
      'Must be at most 1440 minutes (24 h)',
    );
  });

  it('controlError: pattern message reads "Use a color code like #FF0000"', () => {
    setup();
    component.form.controls.sectionColorA.setValue('not-a-color');
    component.form.controls.sectionColorA.markAsTouched();
    expect(component.controlError('sectionColorA')).toBe('Use a color code like #FF0000');
  });

  it('controlError: returns null when invalid but not touched', () => {
    setup();
    component.form.controls.holdTtlSeconds.setValue(30);
    expect(component.form.controls.holdTtlSeconds.invalid).toBe(true);
    expect(component.form.controls.holdTtlSeconds.touched).toBe(false);
    expect(component.controlError('holdTtlSeconds')).toBeNull();
  });

  it('sectionInvalid: false when all controls valid', () => {
    setup();
    expect(component.sectionInvalid().operations).toBe(false);
    expect(component.sectionInvalid().payments).toBe(false);
  });

  it('sectionInvalid: true when a control in the section is invalid', () => {
    setup();
    component.form.controls.holdTtlSeconds.setValue(30);
    expect(component.sectionInvalid().operations).toBe(true);
    expect(component.sectionInvalid().payments).toBe(false);
  });

  it('squareEnvBadgeVariant: production -> success; sandbox -> warning; null -> destructive', () => {
    setup();
    component.squareEnvMode.set('production');
    expect(component.squareEnvBadgeVariant()).toBe('success');
    component.squareEnvMode.set('sandbox');
    expect(component.squareEnvBadgeVariant()).toBe('warning');
    component.squareEnvMode.set(null);
    expect(component.squareEnvBadgeVariant()).toBe('destructive');
  });

  it('squareEnvLabel: production -> Live; sandbox -> Test; null -> Not configured', () => {
    setup();
    component.squareEnvMode.set('production');
    expect(component.squareEnvLabel()).toBe('Live');
    component.squareEnvMode.set('sandbox');
    expect(component.squareEnvLabel()).toBe('Test');
    component.squareEnvMode.set(null);
    expect(component.squareEnvLabel()).toBe('Not configured');
  });

  it('hasUnsavedChanges: tracks form.dirty, false while saving', () => {
    setup();
    expect(component.hasUnsavedChanges()).toBe(false);
    component.form.controls.holdTtlSeconds.setValue(600);
    component.form.controls.holdTtlSeconds.markAsDirty();
    expect(component.hasUnsavedChanges()).toBe(true);
    // Simulate in-flight save by replacing the put response with a never-resolving subject
    putSpy.mockReturnValueOnce(new Subject<any>().asObservable());
    component.save();
    expect(component.hasUnsavedChanges()).toBe(false);
  });

  it('onColorPick: updates control + marks touched + dirty', () => {
    setup();
    const ctrl = component.form.controls.sectionColorA;
    expect(ctrl.touched).toBe(false);
    component.onColorPick('A', { target: { value: '#abcdef' } } as unknown as Event);
    expect(ctrl.value).toBe('#abcdef');
    expect(ctrl.touched).toBe(true);
    expect(ctrl.dirty).toBe(true);
  });

  it('lastSavedLabel: null before save, "Saved at HH:MM" after', () => {
    setup();
    expect(component.lastSavedLabel()).toBeNull();
    component.lastSavedAt.set(new Date(2026, 4, 14, 9, 5).getTime());
    expect(component.lastSavedLabel()).toBe('Saved at 09:05');
  });

  it('sectionColorRows: 5 rows in alphabetical order with stable controls', () => {
    setup();
    expect(component.sectionColorRows.map((r) => r.key)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(component.sectionColorRows[0].control).toBe(component.form.controls.sectionColorA);
    expect(component.sectionColorRows[4].errorKey).toBe('sectionColorE');
  });

  describe('high-impact flip confirmation', () => {
    it('save: no flip => calls API immediately, no pending confirm', () => {
      setup();
      component.form.controls.holdTtlSeconds.setValue(600);
      component.form.controls.holdTtlSeconds.markAsDirty();
      component.save();
      expect(component.pendingConfirm()).toBeNull();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it('save: flipping allowAnonymousPublicBooking off->on opens confirm; does not call API yet', () => {
      setup();
      component.form.controls.allowAnonymousPublicBooking.setValue(true);
      component.form.controls.allowAnonymousPublicBooking.markAsDirty();
      component.save();
      const pending = component.pendingConfirm();
      expect(pending).not.toBeNull();
      expect(pending!.keys).toEqual(['allowAnonymousPublicBooking']);
      expect(component.pendingConfirmLabels()).toEqual([
        'Allow customers to self-book on the public map',
      ]);
      expect(putSpy).not.toHaveBeenCalled();
    });

    it('save: flipping multiple high-impact keys lists all human labels', () => {
      setup();
      component.form.controls.allowAnonymousPublicBooking.setValue(true);
      component.form.controls.allowPastEventPayments.setValue(true);
      component.form.controls.auditVerboseLogging.setValue(true);
      component.save();
      const labels = component.pendingConfirmLabels();
      expect(labels).toContain('Allow customers to self-book on the public map');
      expect(labels).toContain('Allow payments on past events');
      expect(labels).toContain('Detailed activity logs (for support)');
    });

    it('pendingConfirmLabels: empty array when no confirm pending', () => {
      setup();
      expect(component.pendingConfirmLabels()).toEqual([]);
    });

    it('save: turning a high-impact key OFF does NOT trigger confirm', () => {
      setup(of({ ...fullDefaults(), allowAnonymousPublicBooking: true } as any));
      component.form.controls.allowAnonymousPublicBooking.setValue(false);
      component.form.controls.allowAnonymousPublicBooking.markAsDirty();
      component.save();
      expect(component.pendingConfirm()).toBeNull();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it('confirmSave: clears pending + calls API', () => {
      setup();
      component.form.controls.allowAnonymousPublicBooking.setValue(true);
      component.form.controls.allowAnonymousPublicBooking.markAsDirty();
      component.save();
      expect(putSpy).not.toHaveBeenCalled();
      component.confirmSave();
      expect(component.pendingConfirm()).toBeNull();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it('cancelSave: clears pending + leaves form dirty + does not call API', () => {
      setup();
      component.form.controls.auditVerboseLogging.setValue(true);
      component.form.controls.auditVerboseLogging.markAsDirty();
      component.save();
      component.cancelSave();
      expect(component.pendingConfirm()).toBeNull();
      expect(putSpy).not.toHaveBeenCalled();
      expect(component.form.dirty).toBe(true);
    });
  });
});
