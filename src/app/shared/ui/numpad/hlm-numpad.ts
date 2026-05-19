import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideDelete } from '@ng-icons/lucide';

export type HlmNumpadMode = 'phone' | 'integer' | 'decimal';

/**
 * 3×4 on-screen numeric keypad sized for staff iPad host-stand entry.
 * Replaces the iOS tel-keypad (small keys) for phone capture and any
 * other numeric field where the OS keyboard fights for vertical space.
 *
 * @example
 *   <hlm-numpad
 *     [value]="form.controls.phone.value"
 *     (valueChange)="form.controls.phone.setValue($event)"
 *     mode="phone"
 *     caption="→ Phone"
 *     (done)="advanceFocusToName()"
 *   />
 *
 * Pair with `readonly inputmode="none"` on the underlying input so iOS
 * does not raise its keyboard on focus — the numpad becomes the only
 * entry surface for that field.
 *
 * Modes:
 * - phone: caps total digits at 10; rejects further keys silently.
 * - integer: unlimited digits, no decimal.
 * - decimal: unlimited digits, single decimal allowed (long-press 0 or
 *   external "." key — this keypad layout itself stays 3×4 for muscle
 *   memory). Today decimal mode behaves like integer; the field reuses
 *   the OS keyboard for the decimal character. Phase-2 caller can
 *   layer its own "." key.
 *
 * Each key is 80×80 px so it crosses Apple HIG's 44pt minimum even
 * with chunky fingertip taps + glove use behind the host stand.
 * `navigator.vibrate(8)` fires on every press for haptic feedback on
 * Android (no-op on iPadOS Safari — Apple does not expose Vibration
 * API yet).
 */
@Component({
  selector: 'hlm-numpad',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgIcon],
  providers: [provideIcons({ lucideCheck, lucideDelete })],
  template: `
    <div class="grid gap-3" [class.opacity-50]="disabled()">
      <p
        *ngIf="caption()"
        class="text-xs font-semibold uppercase tracking-[0.16em] text-brand-500"
        aria-live="polite"
      >
        {{ caption() }}
      </p>

      <div class="grid grid-cols-3 gap-2" role="group" aria-label="Numeric keypad">
        <button
          *ngFor="let d of digits; trackBy: trackByDigit"
          type="button"
          class="hlm-numpad-key"
          [disabled]="disabled() || digitsDisabled()"
          (click)="onDigit(d)"
          [attr.aria-label]="'Number ' + d"
        >
          {{ d }}
        </button>

        <button
          type="button"
          class="hlm-numpad-key hlm-numpad-key-fn"
          [disabled]="disabled() || backspaceDisabled()"
          (click)="onBackspace()"
          aria-label="Backspace"
        >
          <ng-icon name="lucideDelete" size="28" aria-hidden="true" />
        </button>

        <button
          type="button"
          class="hlm-numpad-key"
          [disabled]="disabled() || digitsDisabled()"
          (click)="onDigit('0')"
          aria-label="Number 0"
        >
          0
        </button>

        <button
          type="button"
          class="hlm-numpad-key hlm-numpad-key-done"
          [disabled]="disabled()"
          (click)="onDone()"
          aria-label="Done"
        >
          <ng-icon name="lucideCheck" size="28" aria-hidden="true" />
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .hlm-numpad-key {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 5rem;
        width: 100%;
        border-radius: 1rem;
        font-size: 2rem;
        font-weight: 600;
        background: hsl(var(--accent, 30 35% 96%));
        color: hsl(var(--accent-foreground, 30 35% 12%));
        transition: transform 80ms ease, background-color 120ms ease;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .hlm-numpad-key:active:not(:disabled) {
        transform: scale(0.96);
        background: hsl(var(--accent, 30 35% 92%));
      }
      .hlm-numpad-key:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .hlm-numpad-key-fn {
        background: hsl(var(--muted, 30 15% 92%));
      }
      .hlm-numpad-key-done {
        background: hsl(var(--primary, 30 80% 50%));
        color: hsl(var(--primary-foreground, 0 0% 100%));
      }
    `,
  ],
})
export class HlmNumpad {
  public readonly value = input<string>('');
  public readonly mode = input<HlmNumpadMode>('integer');
  public readonly caption = input<string>('');
  public readonly disabled = input<boolean>(false);

  public readonly valueChange = output<string>();
  public readonly done = output<void>();

  protected readonly digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

  protected readonly digitsDisabled = computed(() => {
    if (this.mode() !== 'phone') return false;
    const raw = String(this.value() ?? '');
    return raw.replace(/\D/g, '').length >= 10;
  });

  protected readonly backspaceDisabled = computed(() => {
    return String(this.value() ?? '').length === 0;
  });

  protected trackByDigit(_index: number, digit: string): string {
    return digit;
  }

  protected onDigit(digit: string): void {
    if (this.disabled() || this.digitsDisabled()) return;
    const next = String(this.value() ?? '') + digit;
    this.valueChange.emit(next);
    this.haptic();
  }

  protected onBackspace(): void {
    if (this.disabled() || this.backspaceDisabled()) return;
    const current = String(this.value() ?? '');
    this.valueChange.emit(current.slice(0, -1));
    this.haptic();
  }

  protected onDone(): void {
    if (this.disabled()) return;
    this.done.emit();
    this.haptic();
  }

  private haptic(): void {
    if (typeof navigator === 'undefined') return;
    const vibrate = (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate;
    if (typeof vibrate === 'function') {
      try {
        vibrate.call(navigator, 8);
      } catch {
        // some browsers throw on rapid calls — ignore
      }
    }
  }
}
