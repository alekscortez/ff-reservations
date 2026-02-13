import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserQRCodeReader, IScannerControls } from '@zxing/browser';
import { CheckInPass, CheckInService, CheckInVerifyResult } from '../../../core/http/check-in.service';

@Component({
  selector: 'app-check-in',
  imports: [CommonModule, FormsModule],
  templateUrl: './check-in.html',
  styleUrl: './check-in.scss',
})
export class CheckIn implements OnDestroy {
  private api = inject(CheckInService);
  @ViewChild('scannerVideo') scannerVideoRef?: ElementRef<HTMLVideoElement>;

  eventDate = '';
  reservationId = '';
  scannerInput = '';
  scannerDevice = 'staff-web';

  loadingPass = false;
  loadingVerify = false;
  error: string | null = null;
  notice: string | null = null;
  scannerError: string | null = null;

  currentPass: CheckInPass | null = null;
  verifyResult: CheckInVerifyResult | null = null;

  scannerSupported = this.hasScannerSupport();
  scannerActive = false;
  scannerFacing: 'environment' | 'user' = 'environment';

  private qrReader: BrowserQRCodeReader | null = null;
  private scannerControls: IScannerControls | null = null;
  private scannerStartInFlight = false;
  private lastScannedToken = '';
  private lastScannedAt = 0;

  ngOnDestroy(): void {
    this.stopScanner();
  }

  fetchOrCreatePass(): void {
    const eventDate = this.eventDate.trim();
    const reservationId = this.reservationId.trim();
    if (!this.isIsoDate(eventDate) || !reservationId) {
      this.error = 'Event date and reservation ID are required.';
      return;
    }
    this.loadingPass = true;
    this.error = null;
    this.notice = null;
    this.api.getReservationPass(reservationId, eventDate).subscribe({
      next: (res) => {
        this.currentPass = res?.pass ?? null;
        this.notice = this.currentPass
          ? 'Active check-in pass is ready.'
          : 'No active pass found.';
        this.loadingPass = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to fetch check-in pass.';
        this.loadingPass = false;
      },
    });
  }

  reissuePass(): void {
    const eventDate = this.eventDate.trim();
    const reservationId = this.reservationId.trim();
    if (!this.isIsoDate(eventDate) || !reservationId) {
      this.error = 'Event date and reservation ID are required.';
      return;
    }
    this.loadingPass = true;
    this.error = null;
    this.notice = null;
    this.api.issueReservationPass(reservationId, eventDate, true).subscribe({
      next: (res) => {
        this.currentPass = res?.pass ?? null;
        this.notice = 'Pass reissued. Previous pass is now invalid.';
        this.loadingPass = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to reissue pass.';
        this.loadingPass = false;
      },
    });
  }

  verify(): void {
    const parsedToken = this.extractToken(this.scannerInput);
    if (!parsedToken) {
      this.error = 'Paste or scan a token / pass URL first.';
      return;
    }
    this.loadingVerify = true;
    this.error = null;
    this.notice = null;
    this.verifyResult = null;
    this.api.verifyToken(parsedToken, this.scannerDevice.trim() || 'staff-web').subscribe({
      next: (result) => {
        this.verifyResult = result ?? null;
        this.notice = this.verifyResult?.ok ? 'Check-in accepted.' : null;
        if (this.verifyResult?.ok) this.stopScanner();
        this.loadingVerify = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to verify pass.';
        this.loadingVerify = false;
      },
    });
  }

  async startScanner(): Promise<void> {
    if (!this.scannerSupported) {
      this.scannerError = 'Camera scanner is not supported on this browser/device.';
      return;
    }
    if (this.scannerStartInFlight) return;
    const videoEl = this.scannerVideoRef?.nativeElement;
    if (!videoEl) {
      this.scannerError = 'Scanner view is not ready yet.';
      return;
    }

    this.scannerStartInFlight = true;
    this.scannerError = null;
    this.stopScanner();

    try {
      if (!this.qrReader) {
        this.qrReader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 180,
          delayBetweenScanSuccess: 700,
          tryPlayVideoTimeout: 4000,
        });
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: this.scannerFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      this.scannerControls = await this.qrReader.decodeFromConstraints(
        constraints,
        videoEl,
        (result, decodeError) => {
          if (result?.getText) {
            this.onScannerValue(result.getText());
            return;
          }
          if (decodeError && !this.isIgnorableDecodeError(decodeError)) {
            this.scannerError = 'Scanner decode error. Adjust framing and lighting.';
          }
        }
      );
      this.scannerActive = true;
    } catch (err) {
      const message = String((err as any)?.message ?? '').trim();
      this.scannerError = message || 'Unable to start camera scanner.';
      this.stopScanner();
    } finally {
      this.scannerStartInFlight = false;
    }
  }

  stopScanner(): void {
    if (this.scannerControls) {
      try {
        this.scannerControls.stop();
      } catch {
        // Ignore stop errors from disposed controls.
      }
      this.scannerControls = null;
    }
    const videoEl = this.scannerVideoRef?.nativeElement;
    if (videoEl) {
      videoEl.pause();
      videoEl.srcObject = null;
    }
    this.scannerActive = false;
  }

  async toggleCameraFacing(): Promise<void> {
    this.scannerFacing = this.scannerFacing === 'environment' ? 'user' : 'environment';
    if (this.scannerActive) {
      await this.startScanner();
    }
  }

  copyPassLink(): void {
    const url = String(this.currentPass?.url ?? '').trim();
    if (!url) return;
    if (!navigator?.clipboard?.writeText) {
      this.notice = 'Clipboard is not available on this device.';
      return;
    }
    navigator.clipboard
      .writeText(url)
      .then(() => {
        this.notice = 'Pass link copied.';
      })
      .catch(() => {
        this.notice = 'Failed to copy. Copy manually from the field.';
      });
  }

  openSms(): void {
    const link = String(this.currentPass?.url ?? '').trim();
    if (!link) return;
    const body = encodeURIComponent(`Your FF check-in pass: ${link}`);
    window.open(`sms:?&body=${body}`, '_blank');
  }

  openWhatsApp(): void {
    const link = String(this.currentPass?.url ?? '').trim();
    if (!link) return;
    const body = encodeURIComponent(`Your FF check-in pass: ${link}`);
    window.open(`https://wa.me/?text=${body}`, '_blank');
  }

  resultBadgeClass(): string {
    const code = String(this.verifyResult?.code ?? '').toUpperCase();
    if (code === 'CHECKED_IN') return 'bg-success-100 text-success-800 border-success-300';
    if (code === 'ALREADY_USED') return 'bg-warning-100 text-warning-800 border-warning-300';
    return 'bg-danger-100 text-danger-800 border-danger-300';
  }

  private onScannerValue(raw: string): void {
    const parsedToken = this.extractToken(raw);
    if (!parsedToken) return;
    const now = Date.now();
    if (parsedToken === this.lastScannedToken && now - this.lastScannedAt < 2500) {
      return;
    }
    this.lastScannedToken = parsedToken;
    this.lastScannedAt = now;
    this.scannerInput = raw;
    this.verify();
  }

  private extractToken(rawInput: string): string {
    const raw = String(rawInput ?? '').trim();
    if (!raw) return '';
    if (/^ffr-checkin:/i.test(raw)) {
      return raw.replace(/^ffr-checkin:/i, '').trim();
    }
    if (!raw.includes('://')) {
      const match = raw.match(/(?:^|[?&])token=([^&]+)/i);
      if (!match) return raw;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    try {
      const parsed = new URL(raw);
      return String(parsed.searchParams.get('token') ?? '').trim() || raw;
    } catch {
      return raw;
    }
  }

  private isIsoDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim());
  }

  private hasScannerSupport(): boolean {
    return Boolean(globalThis?.navigator?.mediaDevices?.getUserMedia);
  }

  private isIgnorableDecodeError(err: unknown): boolean {
    const name = String((err as any)?.name ?? '').toLowerCase();
    const message = String((err as any)?.message ?? '').toLowerCase();
    return (
      name.includes('notfound') ||
      name.includes('checksum') ||
      name.includes('format') ||
      message.includes('not found')
    );
  }
}
