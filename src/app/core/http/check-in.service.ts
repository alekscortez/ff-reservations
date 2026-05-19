import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export interface CheckInPass {
  passId: string | null;
  reservationId: string | null;
  eventDate: string | null;
  tableId: string | null;
  tableIds?: string[];
  customerName: string | null;
  phone: string | null;
  status: 'ISSUED' | 'USED' | 'REVOKED' | 'EXPIRED' | string | null;
  issuedAt: number | null;
  issuedBy: string | null;
  expiresAt: number | null;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  token: string | null;
  url: string | null;
  qrPayload: string | null;
}

export interface CheckInPassIssueResponse {
  issued: boolean;
  reused: boolean;
  pass: CheckInPass | null;
  latestPass?: CheckInPass | null;
}

export interface GoogleWalletSaveResponse {
  saveUrl: string;
  classId: string;
  objectId: string;
}

export interface CheckInVerifyResult {
  ok: boolean;
  code:
    | 'CHECKED_IN'
    | 'ALREADY_USED'
    | 'EXPIRED'
    | 'REVOKED'
    | 'INVALID_TOKEN'
    | string;
  message: string;
  pass: CheckInPass | null;
  reservation: {
    reservationId: string | null;
    eventDate: string | null;
    tableId: string | null;
    tableIds?: string[];
    customerName: string | null;
  } | null;
}

@Injectable({ providedIn: 'root' })
export class CheckInService {
  private api = inject(ApiClient);

  getReservationPass(reservationId: string, eventDate: string) {
    return this.api.get<CheckInPassIssueResponse>(`/reservations/${reservationId}/check-in-pass`, { eventDate });
  }

  issueReservationPass(reservationId: string, eventDate: string, reissue = false) {
    return this.api.post<CheckInPassIssueResponse>(`/reservations/${reservationId}/check-in-pass`, {
      eventDate,
      reissue,
    });
  }

  verifyToken(token: string, scannerDevice?: string) {
    return this.api
      .post<{ result: CheckInVerifyResult }>('/check-in/verify', {
        token,
        scannerDevice: scannerDevice ?? '',
      })
      .pipe(map((res) => res?.result));
  }

  // Staff Google Wallet save-URL endpoint. Used by the detail-modal Pass
  // tab so staff can SMS/WhatsApp/copy an Android-installable link for
  // a customer. Returns 501 when the backend isn't configured — the FE
  // hides the Google button in that case.
  generateGoogleWalletSaveUrl(reservationId: string, eventDate: string) {
    return this.api.post<GoogleWalletSaveResponse>(
      `/reservations/${encodeURIComponent(reservationId)}/google-wallet-pass`,
      { eventDate }
    );
  }
}
