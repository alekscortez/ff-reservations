import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toDataURL } from 'qrcode';

@Component({
  selector: 'app-check-in-pass-page',
  imports: [CommonModule],
  templateUrl: './check-in-pass.html',
  styleUrl: './check-in-pass.scss',
})
export class CheckInPassPage {
  private route = inject(ActivatedRoute);

  token = computed(() => String(this.route.snapshot.queryParamMap.get('token') ?? '').trim());
  payload = computed(() => {
    const token = this.token();
    return token ? `ffr-checkin:${token}` : '';
  });
  qrDataUrl = signal('');
  qrError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const payload = this.payload();
      void this.renderQr(payload);
    });
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
}
