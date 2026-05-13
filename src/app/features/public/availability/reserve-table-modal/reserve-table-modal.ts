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
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { HlmAlert } from '../../../../shared/ui/alert';
import { HlmButton } from '../../../../shared/ui/button';
import { HlmDialog } from '../../../../shared/ui/dialog';
import { HlmInput } from '../../../../shared/ui/input';
import {
  CreatePublicReservationResponse,
  PublicBookingsService,
} from '../../../../core/http/public-bookings.service';
import { PublicAvailabilityTable } from '../../../../core/http/public-availability.service';

// Error code → human-readable message + retryable flag. The codes match
// what the backend returns from POST /public/reservations.
// Cloudflare Turnstile global. The script (loaded lazily on first modal
// open) attaches `window.turnstile` with render/reset/remove methods.
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
      appearance?: 'always' | 'execute' | 'interaction-only';
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
  getResponse?: (widgetId?: string) => string | undefined;
}

// Friendly translations of the most common Cloudflare Turnstile error
// codes. Full list: https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
// We surface the code so the operator can search docs if a new one shows up.
function describeTurnstileError(code: string): string {
  const c = String(code ?? '').trim();
  if (!c) return 'Verification widget reported an error. Please try again.';
  if (c.startsWith('1102')) {
    return 'This site is not authorized for this domain. (Check Turnstile hostnames.)';
  }
  if (c.startsWith('110')) {
    return `Verification config error (code ${c}). Please refresh and try again.`;
  }
  if (c.startsWith('200') || c.startsWith('300')) {
    return `Network glitch verifying you (code ${c}). Please try again.`;
  }
  if (c.startsWith('400')) {
    return `Too many verification attempts (code ${c}). Please wait a moment.`;
  }
  return `Verification error (code ${c}). Please try again.`;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_SCRIPT_ID = 'ff-turnstile-script';

// Idempotent global script loader. Returns a promise that resolves once
// window.turnstile is available. Subsequent calls (different modal opens)
// reuse the same script tag + a memoized ready promise.
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
      // Another caller is already loading it — wait for it.
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

const ERROR_MESSAGES: Record<string, string> = {
  BOOKING_DISABLED:
    'Online booking is not available right now. Please contact us.',
  TURNSTILE_FAILED:
    'Could not verify you are human. Please refresh and try again.',
  EVENT_NOT_FOUND: 'This event is no longer available.',
  TABLE_INVALID: 'One of the selected tables is no longer available.',
  MAX_TABLES_EXCEEDED:
    'Too many tables selected. Please reduce your selection.',
  TABLE_NOT_AVAILABLE:
    'A table you selected was just taken. Please pick another and try again.',
  ACTIVE_HOLD_EXISTS:
    'You already have a pending reservation. Please complete or release it first.',
  INVALID_PHONE: 'Please enter a valid US or Mexico phone number.',
  MISSING_EVENT_DATE: 'Please reload the page and try again.',
};

@Component({
  selector: 'app-reserve-table-modal',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HlmAlert,
    HlmButton,
    HlmDialog,
    HlmInput,
  ],
  templateUrl: './reserve-table-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReserveTableModal implements OnDestroy {
  private bookings = inject(PublicBookingsService);
  // DestroyRef injected at construction so `takeUntilDestroyed(this.destroyRef)`
  // can be called from event handlers (which don't run in injection context).
  // Without this, the bare `takeUntilDestroyed()` throws synchronously inside
  // submit() and the HTTP error never propagates → button stuck on "Reserving…".
  private destroyRef = inject(DestroyRef);

  @ViewChild('turnstileContainer', { static: false })
  turnstileContainer?: ElementRef<HTMLElement>;

  private turnstileWidgetId: string | null = null;
  readonly turnstileToken = signal<string>('');
  readonly turnstileError = signal<string | null>(null);

  constructor() {
    // Mount the Turnstile widget when the modal opens AND a site key is
    // configured. Reset/remove on close. We re-render every open (instead
    // of mounting once) so a stale token from a previous attempt doesn't
    // get reused — Turnstile tokens are single-use.
    effect(() => {
      const isOpen = this.open();
      const siteKey = String(this.turnstileSiteKey() ?? '').trim();
      if (!isOpen || !siteKey) {
        this.teardownTurnstile();
        return;
      }
      // The container is a ViewChild on a *ngIf="open()" child — Angular
      // attaches it after the view re-renders. Defer one microtask so the
      // queryRef has the element.
      queueMicrotask(() => this.renderTurnstile(siteKey));
    });
  }

  ngOnDestroy(): void {
    this.teardownTurnstile();
  }

  private async renderTurnstile(siteKey: string): Promise<void> {
    const container = this.turnstileContainer?.nativeElement;
    if (!container) return;
    // Wipe any prior render in case the modal re-opens; otherwise the
    // widget stacks and only the first instance gets a token.
    this.teardownTurnstile();
    let turnstile: TurnstileGlobal;
    try {
      turnstile = await ensureTurnstileScript();
    } catch {
      this.turnstileError.set(
        'Could not load human-verification widget. Refresh and try again.'
      );
      return;
    }
    if (!this.open()) return; // modal closed mid-load
    try {
      this.turnstileWidgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token: string) => {
          this.turnstileToken.set(String(token ?? ''));
          this.turnstileError.set(null);
        },
        'error-callback': (errorCode?: string) => {
          this.turnstileToken.set('');
          // Log the raw code so we can grep for it; show a friendlier
          // message to the customer.
          console.warn('[turnstile] error-callback', {
            errorCode,
            host: window.location.host,
          });
          this.turnstileError.set(describeTurnstileError(errorCode ?? ''));
        },
        'expired-callback': () => {
          this.turnstileToken.set('');
        },
        theme: 'light',
        size: 'normal',
      });
    } catch {
      this.turnstileError.set(
        'Could not render the human-verification widget.'
      );
    }
  }

  private teardownTurnstile(): void {
    if (this.turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.remove(this.turnstileWidgetId);
      } catch {
        // ignore — widget may already be gone
      }
    }
    this.turnstileWidgetId = null;
    this.turnstileToken.set('');
    this.turnstileError.set(null);
  }

  // Signal inputs (Angular 17+) so the computed properties below
  // (totalAmount, canAddAnother, hasTurnstile) re-evaluate when parent
  // updates the bindings. With the legacy `@Input` decorator, `computed()`
  // can't track the property read — the value memoizes to whatever was
  // captured on first render and never refreshes.
  readonly open = input<boolean>(false);
  readonly eventDate = input<string | null>(null);
  readonly eventName = input<string | null>(null);
  readonly selectedTables = input<PublicAvailabilityTable[]>([]);
  readonly maxTables = input<number>(4);
  readonly turnstileSiteKey = input<string | null>(null);
  // Optional E.164 phone for the "larger party" fallback CTA. When the
  // customer hits the per-booking cap, the modal swaps "+ Add another
  // table" for a friendlier "we'll help directly" card with Call /
  // WhatsApp buttons. Hidden entirely when no contact phone is set.
  readonly contactPhone = input<string | null>(null);

  @Output() closed = new EventEmitter<void>();
  @Output() addAnother = new EventEmitter<void>();
  @Output() removeTable = new EventEmitter<string>();
  @Output() submitted = new EventEmitter<{
    response: CreatePublicReservationResponse;
    eventDate: string;
  }>();

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetails = signal<{ unavailableTableIds?: string[] } | null>(
    null
  );

  form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    phone: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(10)],
    }),
    email: new FormControl('', { nonNullable: true }),
  });

  readonly canAddAnother = computed(
    () => this.selectedTables().length < this.maxTables()
  );

  readonly totalAmount = computed(() =>
    this.selectedTables().reduce((sum, t) => sum + Number(t.price ?? 0), 0)
  );

  readonly hasTurnstile = computed(() =>
    Boolean(String(this.turnstileSiteKey() ?? '').trim())
  );

  readonly hasContactPhone = computed(() =>
    Boolean(String(this.contactPhone() ?? '').trim())
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

  onClose(): void {
    if (this.submitting()) return;
    this.closed.emit();
  }

  onAddAnother(): void {
    this.addAnother.emit();
  }

  onRemoveTable(tableId: string): void {
    this.removeTable.emit(tableId);
  }

  trackTableById(_index: number, table: PublicAvailabilityTable): string {
    return table.id;
  }

  submit(): void {
    if (this.submitting()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const eventDate = this.eventDate();
    if (!eventDate) {
      this.errorMessage.set(ERROR_MESSAGES['MISSING_EVENT_DATE']);
      return;
    }
    const tables = this.selectedTables();
    if (tables.length === 0) {
      this.errorMessage.set('Please select at least one table.');
      return;
    }

    // Block submit when Turnstile is configured but we haven't captured
    // a token yet. Backend would 403 anyway; this saves the round trip
    // and gives a clearer error to the customer.
    if (this.hasTurnstile() && !this.turnstileToken()) {
      this.errorMessage.set(
        'Please complete the human-verification widget above before continuing.'
      );
      return;
    }

    this.errorMessage.set(null);
    this.errorDetails.set(null);
    this.submitting.set(true);

    const tableIds = tables.map((t) => t.id);
    const token = this.turnstileToken().trim();
    this.bookings
      .createReservation({
        eventDate,
        tableIds,
        customer: {
          name: this.form.controls.name.value.trim(),
          phone: this.form.controls.phone.value.trim(),
          email: this.form.controls.email.value.trim() || undefined,
        },
        turnstileToken: token || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.submitting.set(false);
          this.submitted.emit({ response, eventDate });
        },
        error: (err: unknown) => {
          this.submitting.set(false);
          this.applyError(err);
        },
      });
  }

  private applyError(err: unknown): void {
    if (err instanceof HttpErrorResponse) {
      const code = String((err.error as { code?: string } | null)?.code ?? '');
      const message = String(
        (err.error as { message?: string } | null)?.message ?? ''
      );
      const friendly = ERROR_MESSAGES[code] || message || 'Something went wrong.';
      this.errorMessage.set(friendly);
      const unavailable = (err.error as { unavailableTableIds?: string[] })
        ?.unavailableTableIds;
      if (Array.isArray(unavailable)) {
        this.errorDetails.set({ unavailableTableIds: unavailable });
      }
      // Turnstile tokens are single-use. If the backend rejected ours
      // (replay, expired, signature mismatch), the widget needs a fresh
      // challenge before the customer can retry.
      if (code === 'TURNSTILE_FAILED') {
        this.resetTurnstileWidget();
      }
      return;
    }
    this.errorMessage.set('Network error. Please try again.');
  }

  private resetTurnstileWidget(): void {
    this.turnstileToken.set('');
    if (this.turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.reset(this.turnstileWidgetId);
      } catch {
        // Fall through to a fresh render if reset fails.
      }
    }
  }
}
