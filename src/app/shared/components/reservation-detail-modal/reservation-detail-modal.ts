import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';

import { PaymentMethodLabelPipe } from '../../payment-method-label.pipe';
import { PhoneDisplayPipe } from '../../phone-display.pipe';
import { SystemActorLabelPipe } from '../../system-actor-label.pipe';
import { TableLabelPipe, formatTableLabelLower } from '../../table-label.pipe';
import { type BadgeVariants, HlmBadge } from '../../ui/badge';
import { HlmButton } from '../../ui/button';
import { HlmDialog } from '../../ui/dialog';
import { HlmInput } from '../../ui/input';
import {
  type CheckInPassState,
  type GeneratedCheckInPass,
  type GeneratedPaymentLink,
  type PaymentLinkSmsState,
  type ReservationHistoryViewItem,
} from '../../models/reservation-detail.model';
import {
  isPassEligiblePaymentStatus,
  type ReservationItem,
} from '../../models/reservation.model';

export type ReservationDetailTab = 'overview' | 'links' | 'pass' | 'history';

/**
 * Shared reservation detail modal used by the staff Dashboard
 * (urgent-payment row click) and the Reservations page (table row
 * click). Renders the 4-tab UI (overview / links / pass / history)
 * and emits one event per action — the parent owns all loading,
 * error, and notice state.
 *
 * The component does NOT manage the open/close lifecycle: the
 * parent renders it conditionally via *ngIf="open" and listens for
 * (close) to dismiss. When the dialog is dismissed for any reason
 * (Esc, backdrop, X button, "Keep" click), the (close) event fires
 * exactly once.
 *
 * Predicates like canGeneratePaymentLink / canManageCheckInPass /
 * canReissueCheckInPass are pure functions of the ReservationItem
 * and live in the component so both consumers share the same
 * gating rules.
 */
@Component({
  selector: 'reservation-detail-modal',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    PaymentMethodLabelPipe,
    PhoneDisplayPipe,
    SystemActorLabelPipe,
    TableLabelPipe,
    HlmBadge,
    HlmButton,
    HlmDialog,
    HlmInput,
  ],
  providers: [provideIcons({ lucideX })],
  templateUrl: './reservation-detail-modal.html',
})
export class ReservationDetailModal {
  @Input() reservation: ReservationItem | null = null;
  @Input() paymentLink: GeneratedPaymentLink | null = null;
  @Input() paymentLinkSmsState: PaymentLinkSmsState | null = null;
  @Input() paymentLinkError: string | null = null;
  @Input() paymentLinkNotice: string | null = null;
  @Input() squareLinkLoading = false;
  @Input() checkInPass: GeneratedCheckInPass | null = null;
  @Input() checkInPassState: CheckInPassState | null = null;
  @Input() checkInPassError: string | null = null;
  @Input() checkInPassNotice: string | null = null;
  @Input() checkInPassLoading = false;
  // Parent toggles based on whether the BE has Google Wallet configured
  // (the FE never calls /google-wallet-pass when this is false). Hides
  // the "Google Wallet link" button in the Pass tab.
  @Input() googleWalletAvailable = false;
  @Input() googleWalletLoading = false;
  @Input() googleWalletError: string | null = null;
  @Input() googleWalletNotice: string | null = null;
  @Input() history: ReservationHistoryViewItem[] | null = null;
  @Input() historyLoading = false;
  @Input() historyError: string | null = null;
  @Input() canCancel = true;

  @Output() close = new EventEmitter<void>();
  @Output() takePayment = new EventEmitter<void>();
  @Output() changeTables = new EventEmitter<void>();
  @Output() generateSquareLink = new EventEmitter<void>();
  @Output() sendSms = new EventEmitter<void>();
  @Output() copyLink = new EventEmitter<void>();
  @Output() openSms = new EventEmitter<void>();
  @Output() openWhatsApp = new EventEmitter<void>();
  @Output() share = new EventEmitter<void>();
  @Output() reissuePass = new EventEmitter<void>();
  @Output() copyPassLink = new EventEmitter<void>();
  @Output() openSmsPass = new EventEmitter<void>();
  @Output() openWhatsAppPass = new EventEmitter<void>();
  @Output() sharePass = new EventEmitter<void>();
  @Output() generateGoogleWalletLink = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  readonly tab = signal<ReservationDetailTab>('overview');

  canGeneratePaymentLink(item: ReservationItem): boolean {
    return (
      item.status === 'CONFIRMED' &&
      item.paymentStatus !== 'PAID' &&
      item.paymentStatus !== 'COURTESY' &&
      !this.isPastEvent(item)
    );
  }

  remainingAmount(item: ReservationItem): number {
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    return Math.max(0, Number((due - paid).toFixed(2)));
  }

  canManageCheckInPass(item: ReservationItem): boolean {
    return item.status === 'CONFIRMED' && isPassEligiblePaymentStatus(item.paymentStatus);
  }

  canReissueCheckInPass(item: ReservationItem): boolean {
    if (!this.canManageCheckInPass(item)) return false;
    return this.checkInPassState?.status !== 'USED';
  }

  canCancelReservation(item: ReservationItem): boolean {
    return !this.isPastEvent(item) && item.status === 'CONFIRMED';
  }

  canChangeTables(item: ReservationItem): boolean {
    return (
      item.status === 'CONFIRMED' &&
      item.paymentStatus !== 'COURTESY' &&
      item.paymentStatus !== 'REFUNDED' &&
      !this.isPastEvent(item)
    );
  }

  isPastEvent(item: ReservationItem): boolean {
    const today = this.todayString();
    return Boolean(item.eventDate && item.eventDate < today);
  }

  formatDeadline(deadlineAt?: string | null, eventDate?: string): string {
    if (!deadlineAt) return '—';
    const match = String(deadlineAt)
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
    if (!match) return String(deadlineAt);

    const [, yyyy, mm, dd, hh, min] = match;
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthIndex = Number(mm) - 1;
    const month = monthNames[monthIndex] ?? mm;
    const hour24 = Number(hh);
    const isPm = hour24 >= 12;
    const hour12 = hour24 % 12 || 12;
    const amPm = isPm ? 'PM' : 'AM';
    const timeLabel = `${hour12}:${min} ${amPm}`;

    if (eventDate && this.isNextDay(deadlineAt, eventDate)) {
      return `${timeLabel} (+1 DAY)`;
    }

    return `${month} ${Number(dd)}, ${yyyy} ${timeLabel}`;
  }

  paymentLinkSmsBadgeVariant(status: string | null | undefined): BadgeVariants['variant'] {
    const normalized = String(status ?? '').trim().toUpperCase();
    if (normalized === 'SENT') return 'success';
    if (normalized === 'FAILED') return 'danger';
    return 'secondary';
  }

  checkInStateLabel(status: string | null | undefined): string {
    const normalized = String(status ?? '').toUpperCase();
    if (normalized === 'USED') return 'Checked In';
    if (normalized === 'ISSUED') return 'Issued';
    if (normalized === 'REVOKED') return 'Revoked';
    if (normalized === 'EXPIRED') return 'Expired';
    return 'Unknown';
  }

  checkInStateBadgeVariant(status: string | null | undefined): BadgeVariants['variant'] {
    const normalized = String(status ?? '').toUpperCase();
    if (normalized === 'USED') return 'success';
    if (normalized === 'ISSUED') return 'secondary';
    if (normalized === 'REVOKED') return 'danger';
    if (normalized === 'EXPIRED') return 'warning';
    return 'secondary';
  }

  epochSecondsToMs(value: number | null | undefined): number | null {
    const epoch = Number(value ?? 0);
    return Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : null;
  }

  checkInPassShareMessage(item: ReservationItem, url: string): string {
    const tablesLabel = formatTableLabelLower(item);
    const suffix = tablesLabel ? ` ${tablesLabel}` : '';
    return `Hi ${item.customerName}, here is your FF check-in pass for ${item.eventDate}${suffix}: ${url}`;
  }

  historyEventLabel(eventType: string): string {
    const normalized = String(eventType ?? '').trim().toUpperCase();
    if (normalized === 'RESERVATION_CREATED') return 'Reservation Created';
    if (normalized === 'PAYMENT_RECORDED') return 'Payment Recorded';
    if (normalized === 'PAYMENT_LINK_ISSUED') return 'Square Link';
    if (normalized === 'CASH_APP_LINK_COMPLETED') return 'Cash App Payment Completed';
    if (normalized === 'CASH_APP_LINK_ISSUED') return 'Cash App Link';
    if (normalized === 'PAYMENT_LINK_SMS_SENT') return 'Payment Request Sent';
    if (normalized === 'PAYMENT_LINK_SMS_FAILED') return 'Payment Request Failed';
    if (normalized === 'CHECKIN_PASS_SMS_SENT') return 'Check-In Pass Sent';
    if (normalized === 'CHECKIN_PASS_SMS_FAILED') return 'Check-In Pass Failed';
    if (normalized === 'RESCHEDULE_CREDIT_ISSUED') return 'Reservation Credit Issued';
    if (normalized === 'RESCHEDULE_CREDIT_APPLIED') return 'Reservation Credit Applied';
    if (normalized === 'RESERVATION_CANCELLED') return 'Reservation Cancelled';
    if (normalized === 'CHECKIN_PASS_ISSUED') return 'Check-In Pass Issued';
    if (normalized === 'CHECKIN_PASS_REISSUED') return 'Check-In Pass Reissued';
    if (normalized === 'CHECKED_IN') return 'Checked In';
    return normalized.replace(/_/g, ' ');
  }

  historyEventBadgeVariant(eventType: string): BadgeVariants['variant'] {
    const normalized = String(eventType ?? '').trim().toUpperCase();
    if (normalized === 'CHECKED_IN') return 'success';
    if (normalized === 'PAYMENT_RECORDED') return 'secondary';
    if (normalized === 'PAYMENT_LINK_SMS_SENT') return 'success';
    if (normalized === 'PAYMENT_LINK_SMS_FAILED') return 'danger';
    if (normalized === 'CHECKIN_PASS_SMS_SENT') return 'success';
    if (normalized === 'CHECKIN_PASS_SMS_FAILED') return 'danger';
    if (normalized === 'RESCHEDULE_CREDIT_ISSUED') return 'success';
    if (normalized === 'RESCHEDULE_CREDIT_APPLIED') return 'success';
    if (normalized === 'RESERVATION_CANCELLED') return 'danger';
    return 'secondary';
  }

  historySummary(item: ReservationHistoryViewItem): string {
    const details = item.details ?? {};
    const amount = this.historyNumber(details['amount']);
    const method = this.historyString(details['method']);
    const reason = this.historyString(details['reason']);
    const paymentStatus = this.historyString(details['paymentStatus']);
    const receiptNumber = this.historyString(details['receiptNumber']);
    const smsTo = this.historyString(details['to']);
    const smsError = this.historyString(details['errorMessage']);
    const creditAmount = this.historyNumber(details['amount']);
    const creditExpiresAt = this.historyString(details['expiresAt']);

    if (item.eventType === 'PAYMENT_RECORDED' && amount !== null) {
      const methodText = method ? ` · ${this.paymentMethodLabel(method)}` : '';
      const statusText = paymentStatus ? ` · ${paymentStatus}` : '';
      const receiptText = receiptNumber ? ` · Receipt ${receiptNumber}` : '';
      return `$${amount.toFixed(2)}${methodText}${statusText}${receiptText}`;
    }
    if (item.eventType === 'RESERVATION_CANCELLED' && reason) {
      return reason;
    }
    if (item.eventType === 'RESERVATION_CREATED' && paymentStatus) {
      return `Status ${paymentStatus}`;
    }
    if (item.eventType === 'PAYMENT_LINK_SMS_SENT') {
      return smsTo ? `Sent to ${smsTo}` : 'SMS sent';
    }
    if (item.eventType === 'PAYMENT_LINK_SMS_FAILED') {
      return smsError || 'SMS send failed';
    }
    if (item.eventType === 'PAYMENT_LINK_ISSUED') {
      return 'Square link generated';
    }
    if (item.eventType === 'CASH_APP_LINK_COMPLETED') {
      return 'Cash App payment completed';
    }
    if (item.eventType === 'CASH_APP_LINK_ISSUED') {
      return 'Cash App link generated';
    }
    if (item.eventType === 'CHECKIN_PASS_SMS_SENT') {
      return smsTo ? `Sent to ${smsTo}` : 'SMS sent';
    }
    if (item.eventType === 'CHECKIN_PASS_SMS_FAILED') {
      return smsError || 'SMS send failed';
    }
    if (item.eventType === 'RESCHEDULE_CREDIT_ISSUED') {
      const amountText = creditAmount !== null ? `$${creditAmount.toFixed(2)}` : 'Credit issued';
      return creditExpiresAt ? `${amountText} · Expires ${creditExpiresAt}` : amountText;
    }
    if (item.eventType === 'RESCHEDULE_CREDIT_APPLIED') {
      return amount !== null ? `$${amount.toFixed(2)}` : 'Credit applied';
    }
    return '';
  }

  resetTab(): void {
    this.tab.set('overview');
  }

  private isNextDay(deadlineAt: string, eventDate: string): boolean {
    const d = deadlineAt.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    const e = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d || !e) return false;

    const deadlineUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    const eventUtc = Date.UTC(Number(e[1]), Number(e[2]) - 1, Number(e[3]));
    const dayMs = 24 * 60 * 60 * 1000;
    return deadlineUtc - eventUtc === dayMs;
  }

  private todayString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private historyString(value: unknown): string | null {
    const text = String(value ?? '').trim();
    return text ? text : null;
  }

  private historyNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private paymentMethodLabel(value: string): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'cash') return 'Cash';
    if (normalized === 'cashapp') return 'Cash App Pay';
    if (normalized === 'square') return 'Square';
    if (normalized === 'credit') return 'Reservation Credit';
    return normalized
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
}
