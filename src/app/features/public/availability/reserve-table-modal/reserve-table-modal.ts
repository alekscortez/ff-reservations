import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
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
export class ReserveTableModal {
  private bookings = inject(PublicBookingsService);

  @Input() open = false;
  @Input() eventDate: string | null = null;
  @Input() eventName: string | null = null;
  @Input() selectedTables: PublicAvailabilityTable[] = [];
  @Input() maxTables = 4;
  @Input() turnstileSiteKey: string | null = null;

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
    () => this.selectedTables.length < this.maxTables
  );

  readonly totalAmount = computed(() =>
    this.selectedTables.reduce((sum, t) => sum + Number(t.price ?? 0), 0)
  );

  readonly hasTurnstile = computed(() =>
    Boolean(String(this.turnstileSiteKey ?? '').trim())
  );

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
    if (!this.eventDate) {
      this.errorMessage.set(ERROR_MESSAGES['MISSING_EVENT_DATE']);
      return;
    }
    if (this.selectedTables.length === 0) {
      this.errorMessage.set('Please select at least one table.');
      return;
    }

    this.errorMessage.set(null);
    this.errorDetails.set(null);
    this.submitting.set(true);

    const tableIds = this.selectedTables.map((t) => t.id);
    const eventDate = this.eventDate;
    this.bookings
      .createReservation({
        eventDate,
        tableIds,
        customer: {
          name: this.form.controls.name.value.trim(),
          phone: this.form.controls.phone.value.trim(),
          email: this.form.controls.email.value.trim() || undefined,
        },
        // Turnstile token wiring is intentionally deferred to a follow-up
        // PR — we'll mount the Cloudflare widget once site credentials
        // exist. Backend skips verification when turnstileSiteKey is empty.
      })
      .pipe(takeUntilDestroyed())
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
      return;
    }
    this.errorMessage.set('Network error. Please try again.');
  }
}
