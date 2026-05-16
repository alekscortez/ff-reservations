import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ReservationDetailModal } from './reservation-detail-modal';
import type {
  CheckInPassState,
  GeneratedCheckInPass,
  GeneratedPaymentLink,
  ReservationHistoryViewItem,
} from '../../models/reservation-detail.model';
import type { ReservationItem } from '../../models/reservation.model';

function makeReservation(overrides: Partial<ReservationItem> = {}): ReservationItem {
  return {
    reservationId: 'r-1',
    eventDate: '2099-12-31',
    tableId: 't-1',
    customerName: 'Maria López',
    phone: '+15551234567',
    depositAmount: 500,
    amountDue: 250,
    paymentStatus: 'PARTIAL',
    paymentMethod: 'square',
    paymentDeadlineAt: '2099-12-30T18:00',
    status: 'CONFIRMED',
    createdBy: 'staff',
    ...overrides,
  } as ReservationItem;
}

@Component({
  standalone: true,
  imports: [CommonModule, ReservationDetailModal],
  template: `
    <reservation-detail-modal
      *ngIf="open"
      [reservation]="reservation"
      [paymentLink]="paymentLink"
      [squareLinkLoading]="squareLinkLoading"
      [checkInPass]="checkInPass"
      [checkInPassState]="checkInPassState"
      [checkInPassLoading]="checkInPassLoading"
      [history]="history"
      [historyLoading]="historyLoading"
      [canCancel]="canCancel"
      (close)="onClose()"
      (generateSquareLink)="onGenerateSquare()"
      (sendSms)="onSendSms()"
      (copyLink)="onCopyLink()"
      (reissuePass)="onReissuePass()"
      (cancel)="onCancel()"
    />
  `,
})
class Host {
  open = true;
  reservation: ReservationItem | null = makeReservation();
  paymentLink: GeneratedPaymentLink | null = null;
  squareLinkLoading = false;
  checkInPass: GeneratedCheckInPass | null = null;
  checkInPassState: CheckInPassState | null = null;
  checkInPassLoading = false;
  history: ReservationHistoryViewItem[] | null = null;
  historyLoading = false;
  canCancel = true;

  closeCount = 0;
  generateSquareCount = 0;
  sendSmsCount = 0;
  copyLinkCount = 0;
  reissuePassCount = 0;
  cancelCount = 0;

  onClose() { this.closeCount += 1; }
  onGenerateSquare() { this.generateSquareCount += 1; }
  onSendSms() { this.sendSmsCount += 1; }
  onCopyLink() { this.copyLinkCount += 1; }
  onReissuePass() { this.reissuePassCount += 1; }
  onCancel() { this.cancelCount += 1; }
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function tabButton(fixture: ReturnType<typeof createHost>, label: string): HTMLButtonElement | null {
  const tabs = Array.from(
    fixture.nativeElement.querySelectorAll('reservation-detail-modal [role="tab"]'),
  ) as HTMLButtonElement[];
  return tabs.find((b) => (b.textContent ?? '').trim() === label) ?? null;
}

describe('ReservationDetailModal', () => {
  it('renders nothing when reservation is null', () => {
    const f = createHost({ reservation: null });
    expect(f.nativeElement.querySelector('reservation-detail-modal hlm-dialog')).toBeNull();
  });

  it('renders header, status grid, and tabs', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Maria López');
    expect(text).toContain('CONFIRMED');
    expect(text).toContain('PARTIAL');
    expect(text).toContain('Overview');
    expect(text).toContain('Links');
    expect(text).toContain('Pass');
    expect(text).toContain('Activity');
  });

  it('default tab is overview — Payment Info + Audit are visible', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Payment Info');
    expect(text).toContain('Audit');
  });

  it('shows Cancel Reservation card on overview when canCancel=true', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Cancel Reservation');
  });

  it('hides Cancel Reservation card when canCancel=false', () => {
    const f = createHost({ canCancel: false });
    const text = f.nativeElement.textContent ?? '';
    expect(text).not.toContain('Cancel Reservation');
  });

  it('switching to Links tab reveals the generate button', () => {
    const f = createHost();
    tabButton(f, 'Links')!.click();
    f.detectChanges();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Generate Square Link');
    // Cash App is in-venue only — no link generation in this modal.
    expect(text).not.toContain('Generate Cash App Link');
  });

  it('emits generateSquareLink when Square button is clicked', () => {
    const f = createHost();
    tabButton(f, 'Links')!.click();
    f.detectChanges();
    const buttons = Array.from(
      f.nativeElement.querySelectorAll('reservation-detail-modal button[hlmBtn]'),
    ) as HTMLButtonElement[];
    const btn = buttons.find((b) => (b.textContent ?? '').includes('Generate Square Link'))!;
    btn.click();
    expect(f.componentInstance.generateSquareCount).toBe(1);
  });

  it('emits sendSms when "Send via FF SMS" is clicked', () => {
    const f = createHost({
      paymentLink: {
        method: 'square',
        url: 'https://checkout.square.site/abc',
        amount: 100,
        createdAtMs: Date.now(),
      },
    });
    tabButton(f, 'Links')!.click();
    f.detectChanges();
    const buttons = Array.from(
      f.nativeElement.querySelectorAll('reservation-detail-modal button[hlmBtn]'),
    ) as HTMLButtonElement[];
    const sendBtn = buttons.find((b) => (b.textContent ?? '').includes('Send via FF SMS'))!;
    sendBtn.click();
    expect(f.componentInstance.sendSmsCount).toBe(1);
  });

  it('shows "Past event" notice when eventDate is before today', () => {
    const f = createHost({ reservation: makeReservation({ eventDate: '1999-01-01' }) });
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Past event reservation');
  });

  it('emits cancel when the Cancel Reservation button is clicked', () => {
    const f = createHost();
    const buttons = Array.from(
      f.nativeElement.querySelectorAll('reservation-detail-modal button[hlmBtn]'),
    ) as HTMLButtonElement[];
    const btn = buttons.find((b) => (b.textContent ?? '').trim() === 'Cancel Reservation')!;
    btn.click();
    expect(f.componentInstance.cancelCount).toBe(1);
  });

  it('emits close when the X header button is clicked', () => {
    const f = createHost();
    const closeBtn = f.nativeElement.querySelector(
      'reservation-detail-modal button[aria-label="Close details"]',
    ) as HTMLButtonElement;
    closeBtn.click();
    expect(f.componentInstance.closeCount).toBe(1);
  });

  it('history tab renders "No history yet" when history is empty + not loading', () => {
    const f = createHost({ history: [] });
    tabButton(f, 'Activity')!.click();
    f.detectChanges();
    expect((f.nativeElement.textContent ?? '')).toContain('No history yet for this reservation');
  });

  it('history tab renders rows when history has items', () => {
    const f = createHost({
      history: [
        {
          eventId: 'h-1',
          eventType: 'PAYMENT_RECORDED',
          atMs: Date.now(),
          actor: 'staff',
          source: null,
          details: { amount: 250, method: 'cash', paymentStatus: 'PAID' },
        },
      ],
    });
    tabButton(f, 'Activity')!.click();
    f.detectChanges();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Payment Recorded');
    expect(text).toContain('$250.00');
    expect(text).toContain('Cash');
  });
});
