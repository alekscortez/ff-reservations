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
import { PublicBookingsService } from '../../../../core/http/public-bookings.service';

// Shared with reserve-table-modal — same widget global, same lifecycle.
// Adding the lookup form as a separate component instead of inlining
// into availability.ts keeps two Turnstile widgets cleanly isolated
// (each renders its own widgetId on its own DOM container) without
// either component having to know about the other.
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
  ],
  templateUrl: './find-by-phone-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindByPhoneModal implements OnDestroy {
  private bookings = inject(PublicBookingsService);
  private destroyRef = inject(DestroyRef);

  readonly open = input<boolean>(false);
  readonly turnstileSiteKey = input<string | null>(null);
  readonly contactPhone = input<string | null>(null);

  @Output() closed = new EventEmitter<void>();
  @Output() found = new EventEmitter<{ shortUrl: string }>();

  @ViewChild('findTurnstileContainer', { static: false })
  turnstileContainer?: ElementRef<HTMLElement>;

  readonly form = new FormGroup({
    countryCode: new FormControl<'+1' | '+52'>('+1', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    phone: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, phoneDigitsValidator],
    }),
  });

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly notFound = signal(false);

  readonly turnstileToken = signal<string>('');
  readonly turnstileError = signal<string | null>(null);
  private turnstileWidgetId: string | null = null;

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

  readonly fieldError = (field: 'phone'): string | null => {
    const ctrl = this.form.controls[field];
    if (!ctrl.touched || !ctrl.errors) return null;
    if (ctrl.errors['required']) return 'Phone number is required.';
    if (ctrl.errors['phoneDigits']) return 'Use a 10-digit phone number.';
    return null;
  };

  constructor() {
    effect(() => {
      const isOpen = this.open();
      const siteKey = String(this.turnstileSiteKey() ?? '').trim();
      if (!isOpen) {
        this.errorMessage.set(null);
        this.notFound.set(false);
        this.turnstileToken.set('');
        this.turnstileError.set(null);
        this.form.reset({ countryCode: '+1', phone: '' });
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
    const rawPhone = this.form.controls.phone.value.trim();
    const phoneDigits = rawPhone.replace(/\D/g, '').slice(-10);
    const e164Phone = `${this.form.controls.countryCode.value}${phoneDigits}`;

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.notFound.set(false);

    this.bookings
      .findByPhone(e164Phone, this.turnstileToken().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (res.found && res.shortUrl) {
            this.found.emit({ shortUrl: res.shortUrl });
            return;
          }
          // found:false OR found:true with no shortUrl (legacy hold
          // without a slug — shouldn't happen for anon-public but
          // defensively treated as miss).
          this.notFound.set(true);
          // Re-arm Turnstile so the customer can retry without
          // re-rendering the dialog.
          this.resetTurnstileWidget();
        },
        error: (err: unknown) => {
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
            this.errorMessage.set(
              String(
                (err.error as { message?: string } | null)?.message ??
                  'Could not search for your booking. Please try again.',
              ),
            );
            return;
          }
          this.errorMessage.set('Network error. Please try again.');
        },
      });
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
