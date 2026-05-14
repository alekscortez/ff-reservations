import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  OnDestroy,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { HlmAlert } from '../../../../shared/ui/alert';
import { HlmButton } from '../../../../shared/ui/button';
import { HlmDialog } from '../../../../shared/ui/dialog';
import { HlmInput } from '../../../../shared/ui/input';
import { HlmNativeSelect } from '../../../../shared/ui/native-select';
import { HlmToggle } from '../../../../shared/ui/toggle';
import { PublicBookingsService } from '../../../../core/http/public-bookings.service';
import { TelemetryService } from '../../../../core/http/telemetry.service';

// Find-your-reservation modal. Two lookup channels:
//   - Phone:        /public/lookup-by-phone (PENDING holds only)
//   - Booking code: /public/lookup-by-code  (any state except CANCELLED)
//
// File/selector name (`find-by-phone-modal`) is historical — the modal
// gained Booking-code support in Tier S (2026-05-14). Renaming the file
// would have churned imports + selector references on a Saturday-eve
// without any user-visible benefit.

// Shared with reserve-table-modal — same widget global, same lifecycle.
interface TurnstileGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      'error-callback'?: (errorCode?: string) => void;
      'expired-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'compact';
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

// Window.turnstile global is already declared by reserve-table-modal.ts;
// re-declaring it here triggers a TS "subsequent property declaration"
// merge error. Both modals share the same widget global.

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_SCRIPT_ID = 'ff-turnstile-script';

let turnstileReady: Promise<TurnstileGlobal> | null = null;
function ensureTurnstileScript(): Promise<TurnstileGlobal> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('no window'));
  }
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise<TurnstileGlobal>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    const onReady = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('turnstile script loaded but window.turnstile is missing'));
    };
    if (existing) {
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', () => reject(new Error('turnstile script load failed')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = onReady;
    script.onerror = () => reject(new Error('turnstile script load failed'));
    document.head.appendChild(script);
  });
  return turnstileReady;
}

function phoneDigitsValidator(control: AbstractControl): ValidationErrors | null {
  const v = String(control.value ?? '').trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 10 ? null : { phoneDigits: true };
}

// Mirror backend extractConfirmationCodeFromText: 6 chars from the
// reduced alphabet (no 0/O/1/I/L), with optional "FF-" prefix. Used
// for client-side preflight so an obviously bad code doesn't even hit
// the server.
const CODE_ALPHABET_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
function bookingCodeValidator(control: AbstractControl): ValidationErrors | null {
  const v = String(control.value ?? '').trim();
  if (!v) return null;
  // Accept "FF-XXXXXX" or bare "XXXXXX". Strip + uppercase before checking.
  const m = v.match(/^(?:ff-)?([A-Za-z0-9]{6})$/i);
  if (!m) return { bookingCode: true };
  return CODE_ALPHABET_RE.test(m[1].toUpperCase()) ? null : { bookingCode: true };
}

type FindMode = 'phone' | 'code';

@Component({
  selector: 'app-find-by-phone-modal',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HlmAlert,
    HlmButton,
    HlmDialog,
    HlmInput,
    HlmNativeSelect,
    HlmToggle,
  ],
  templateUrl: './find-by-phone-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindByPhoneModal implements OnDestroy {
  private bookings = inject(PublicBookingsService);
  private telemetry = inject(TelemetryService);
  private destroyRef = inject(DestroyRef);

  readonly open = input<boolean>(false);
  readonly turnstileSiteKey = input<string | null>(null);
  readonly contactPhone = input<string | null>(null);

  @Output() closed = new EventEmitter<void>();
  @Output() found = new EventEmitter<{ shortUrl: string }>();

  @ViewChild('findTurnstileContainer', { static: false })
  turnstileContainer?: ElementRef<HTMLElement>;

  readonly mode = signal<FindMode>('phone');

  readonly form = new FormGroup({
    countryCode: new FormControl<'+1' | '+52'>('+1', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    phone: new FormControl('', {
      nonNullable: true,
      // Conditional validators: phone fields are only required when mode
      // is 'phone'. Updated by the mode effect below.
      validators: [Validators.required, phoneDigitsValidator],
    }),
    code: new FormControl('', {
      nonNullable: true,
      // Same conditional treatment — code field only required in 'code'
      // mode.
      validators: [bookingCodeValidator],
    }),
  });

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  // notFound carries which mode the miss came from so the UI can offer
  // the *other* channel as the next step instead of just shrugging.
  readonly notFound = signal<FindMode | null>(null);

  readonly turnstileToken = signal<string>('');
  readonly turnstileError = signal<string | null>(null);
  private turnstileWidgetId: string | null = null;

  readonly isPhoneMode = computed(() => this.mode() === 'phone');
  readonly isCodeMode = computed(() => this.mode() === 'code');

  readonly hasTurnstile = computed(() =>
    Boolean(String(this.turnstileSiteKey() ?? '').trim()),
  );

  readonly hasContactPhone = computed(() =>
    Boolean(String(this.contactPhone() ?? '').trim()),
  );

  readonly telHref = computed(() => {
    const p = String(this.contactPhone() ?? '').trim();
    return p ? `tel:${p}` : '';
  });

  readonly whatsappHref = computed(() => {
    const p = String(this.contactPhone() ?? '').trim();
    if (!p) return '';
    const digits = p.replace(/[^\d]/g, '');
    return digits ? `https://wa.me/${digits}` : '';
  });

  readonly fieldError = (field: 'phone' | 'code'): string | null => {
    const ctrl = this.form.controls[field];
    if (!ctrl.touched || !ctrl.errors) return null;
    if (ctrl.errors['required']) {
      return field === 'phone'
        ? 'Phone number is required.'
        : 'Booking code is required.';
    }
    if (ctrl.errors['phoneDigits']) return 'Use a 10-digit phone number.';
    if (ctrl.errors['bookingCode']) {
      return 'Booking code looks like FF-XXXXXX (6 letters/digits).';
    }
    return null;
  };

  constructor() {
    effect(() => {
      const isOpen = this.open();
      const siteKey = String(this.turnstileSiteKey() ?? '').trim();
      if (!isOpen) {
        // Reset everything on close so the next open is a fresh slate.
        this.errorMessage.set(null);
        this.notFound.set(null);
        this.turnstileToken.set('');
        this.turnstileError.set(null);
        this.mode.set('phone');
        this.form.reset({ countryCode: '+1', phone: '', code: '' });
        this.applyValidatorsForMode('phone');
      } else {
        this.telemetry.fire('find_modal_opened');
      }
      if (!isOpen || !siteKey) {
        this.teardownTurnstile();
        return;
      }
      queueMicrotask(() => this.renderTurnstile(siteKey));
    });
  }

  ngOnDestroy(): void {
    this.teardownTurnstile();
  }

  onClose(): void {
    if (this.submitting()) return;
    this.closed.emit();
  }

  setMode(next: FindMode): void {
    if (this.mode() === next) return;
    this.mode.set(next);
    this.errorMessage.set(null);
    this.notFound.set(null);
    this.applyValidatorsForMode(next);
    this.telemetry.fire('find_modal_tab_changed', {
      extra: { mode: next },
    });
  }

  // Toggle Validators.required between the two fields. Without this the
  // form would require BOTH phone and code regardless of mode (or
  // neither, depending on initial config), and the submit button stays
  // disabled forever.
  private applyValidatorsForMode(mode: FindMode): void {
    const phoneCtrl = this.form.controls.phone;
    const codeCtrl = this.form.controls.code;
    if (mode === 'phone') {
      phoneCtrl.setValidators([Validators.required, phoneDigitsValidator]);
      codeCtrl.setValidators([bookingCodeValidator]);
    } else {
      phoneCtrl.setValidators([phoneDigitsValidator]);
      codeCtrl.setValidators([Validators.required, bookingCodeValidator]);
    }
    phoneCtrl.updateValueAndValidity({ emitEvent: false });
    codeCtrl.updateValueAndValidity({ emitEvent: false });
  }

  submit(): void {
    if (this.submitting()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.hasTurnstile() && !this.turnstileToken()) {
      this.errorMessage.set(
        'Please complete the human-verification widget before continuing.',
      );
      return;
    }
    if (this.mode() === 'phone') {
      this.submitPhone();
    } else {
      this.submitCode();
    }
  }

  private submitPhone(): void {
    const rawPhone = this.form.controls.phone.value.trim();
    const phoneDigits = rawPhone.replace(/\D/g, '').slice(-10);
    const e164Phone = `${this.form.controls.countryCode.value}${phoneDigits}`;

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.notFound.set(null);
    this.telemetry.fire('find_by_phone_submitted');

    this.bookings
      .findByPhone(e164Phone, this.turnstileToken().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (res.found && res.shortUrl) {
            this.telemetry.fire('find_by_phone_found');
            this.found.emit({ shortUrl: res.shortUrl });
            return;
          }
          this.notFound.set('phone');
          this.telemetry.fire('find_by_phone_not_found');
          this.resetTurnstileWidget();
        },
        error: (err: unknown) => this.handleSubmitError(err),
      });
  }

  private submitCode(): void {
    const raw = this.form.controls.code.value.trim();
    // Server canonicalises too, but normalising on the client gives the
    // user immediate "what you typed → what we'll send" parity if they
    // re-open the modal. Strip optional "FF-" prefix.
    const cleaned = raw.replace(/^ff-/i, '').toUpperCase();

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.notFound.set(null);
    this.telemetry.fire('find_by_code_submitted');

    this.bookings
      .findByCode(cleaned, this.turnstileToken().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (res.found && res.shortUrl) {
            this.telemetry.fire('find_by_code_found');
            this.found.emit({ shortUrl: res.shortUrl });
            return;
          }
          this.notFound.set('code');
          this.telemetry.fire('find_by_code_not_found');
          this.resetTurnstileWidget();
        },
        error: (err: unknown) => this.handleSubmitError(err),
      });
  }

  private handleSubmitError(err: unknown): void {
    this.submitting.set(false);
    if (err instanceof HttpErrorResponse) {
      const code = String((err.error as { code?: string } | null)?.code ?? '');
      if (code === 'TURNSTILE_FAILED') {
        this.errorMessage.set(
          'Verification expired. Please complete the widget again.',
        );
        this.resetTurnstileWidget();
        return;
      }
      if (code === 'INVALID_PHONE') {
        this.errorMessage.set(
          'Please enter a valid US or Mexico phone number.',
        );
        return;
      }
      if (code === 'INVALID_CODE' || code === 'MISSING_CODE') {
        this.errorMessage.set(
          'Booking code looks like FF-XXXXXX. Double-check and try again.',
        );
        return;
      }
      this.errorMessage.set(
        String(
          (err.error as { message?: string } | null)?.message ??
            'Could not search for your booking. Please try again.',
        ),
      );
      return;
    }
    this.errorMessage.set('Network error. Please try again.');
  }

  private async renderTurnstile(siteKey: string): Promise<void> {
    const container = this.turnstileContainer?.nativeElement;
    if (!container) return;
    this.teardownTurnstile();
    let turnstile: TurnstileGlobal;
    try {
      turnstile = await ensureTurnstileScript();
    } catch {
      this.turnstileError.set(
        'Could not load human-verification widget. Refresh and try again.',
      );
      return;
    }
    if (!this.open()) return;
    try {
      this.turnstileWidgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token: string) => {
          this.turnstileToken.set(String(token ?? ''));
          this.turnstileError.set(null);
        },
        'error-callback': () => {
          this.turnstileToken.set('');
          this.turnstileError.set('Verification widget error. Please try again.');
        },
        'expired-callback': () => this.turnstileToken.set(''),
        theme: 'light',
        size: 'normal',
      });
    } catch {
      this.turnstileError.set('Could not render the human-verification widget.');
    }
  }

  private teardownTurnstile(): void {
    if (this.turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.remove(this.turnstileWidgetId);
      } catch {
        // ignore
      }
    }
    this.turnstileWidgetId = null;
    this.turnstileToken.set('');
    this.turnstileError.set(null);
  }

  private resetTurnstileWidget(): void {
    this.turnstileToken.set('');
    if (this.turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.reset(this.turnstileWidgetId);
      } catch {
        // ignore
      }
    }
  }
}
