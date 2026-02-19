import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/http/api-client';
import { toDataURL } from 'qrcode';

@Component({
  selector: 'app-check-in-pass-page',
  imports: [CommonModule],
  templateUrl: './check-in-pass.html',
  styleUrl: './check-in-pass.scss',
})
export class CheckInPassPage {
  private route = inject(ActivatedRoute);
  private api = inject(ApiClient);

  token = computed(() => String(this.route.snapshot.queryParamMap.get('token') ?? '').trim());
  payload = computed(() => {
    const token = this.token();
    return token ? `ffr-checkin:${token}` : '';
  });
  qrDataUrl = signal('');
  qrError = signal<string | null>(null);
  pass = signal<{
    reservationId: string | null;
    eventDate: string | null;
    tableId: string | null;
    customerName: string | null;
    status: string | null;
    expiresAt: number | null;
  } | null>(null);

  constructor() {
    effect(() => {
      const payload = this.payload();
      void this.renderQr(payload);
    });
    effect(() => {
      const token = this.token();
      void this.loadPassPreview(token);
    });
  }

  guestName(): string {
    const name = String(this.pass()?.customerName ?? '').trim();
    return name || 'Guest';
  }

  confirmedTable(): string {
    const table = String(this.pass()?.tableId ?? '').trim();
    return table || 'your table';
  }

  confirmedDateLabel(): string {
    const raw = String(this.pass()?.eventDate ?? '').trim();
    if (!raw) return 'your event date';
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  checkCode(): string {
    const token = String(this.token() ?? '').trim();
    if (!token) return 'N/A';
    return token.slice(-8).toUpperCase();
  }

  passStatus(): string {
    const raw = String(this.pass()?.status ?? '').trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    return raw;
  }

  passStatusLabel(): string {
    switch (this.passStatus()) {
      case 'ISSUED':
        return 'Valid';
      case 'USED':
        return 'Checked-In';
      case 'REVOKED':
        return 'Revoked';
      case 'EXPIRED':
        return 'Expired';
      default:
        return 'Unknown';
    }
  }

  passStatusClass(): string {
    switch (this.passStatus()) {
      case 'ISSUED':
        return 'border border-success-200 bg-success-50 text-success-800';
      case 'USED':
        return 'border border-brand-200 bg-brand-100 text-brand-900';
      case 'REVOKED':
        return 'border border-danger-200 bg-danger-50 text-danger-800';
      case 'EXPIRED':
        return 'border border-warning-200 bg-warning-50 text-warning-800';
      default:
        return 'border border-brand-200 bg-brand-50 text-brand-700';
    }
  }

  passStatusMessage(): string {
    switch (this.passStatus()) {
      case 'ISSUED':
        return 'Your reservation is confirmed and valid.';
      case 'USED':
        return 'This reservation has already been checked in.';
      case 'REVOKED':
        return 'This pass was revoked. Please contact staff.';
      case 'EXPIRED':
        return 'This pass has expired. Please contact staff.';
      default:
        return 'Pass status is unavailable. Please contact staff.';
    }
  }

  copyPayload(): void {
    const value = this.payload();
    if (!value) return;
    void this.copyText(value);
  }

  private async copyText(value: string): Promise<boolean> {
    const text = String(value ?? '').trim();
    if (!text) return false;

    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to legacy copy.
      }
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }

  private async renderQr(payload: string): Promise<void> {
    const value = String(payload ?? '').trim();
    if (!value) {
      this.qrDataUrl.set('');
      this.qrError.set(null);
      return;
    }
    try {
      const dataUrl = await toDataURL(value, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360,
        color: {
          dark: '#111111',
          light: '#ffffff',
        },
      });
      this.qrDataUrl.set(dataUrl);
      this.qrError.set(null);
    } catch {
      this.qrDataUrl.set('');
      this.qrError.set('Unable to render QR code on this device.');
    }
  }

  private async loadPassPreview(token: string): Promise<void> {
    const value = String(token ?? '').trim();
    if (!value) {
      this.pass.set(null);
      return;
    }
    try {
      const response = await firstValueFrom(
        this.api.get<{
          pass: {
            reservationId: string | null;
            eventDate: string | null;
            tableId: string | null;
            customerName: string | null;
            status: string | null;
            expiresAt: number | null;
          };
        }>('/check-in/pass', { token: value })
      );
      this.pass.set(response?.pass ?? null);
    } catch {
      this.pass.set(null);
    }
  }
}
