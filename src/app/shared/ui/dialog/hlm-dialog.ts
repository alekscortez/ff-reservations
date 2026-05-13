import { Component, OnDestroy, computed, inject, input, output } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style modal dialog using Angular CDK for focus trap +
 * Escape handling + backdrop click → close. Caller controls
 * open/close state with *ngIf; the dialog emits `close` for any
 * "should dismiss" intent.
 *
 * @example
 *   // Default (centered, max-w-2xl, fits content):
 *   <hlm-dialog *ngIf="showModal" (close)="showModal = false">
 *     <h3>Confirm action</h3>
 *   </hlm-dialog>
 *
 *   // Full-screen on mobile, centered on desktop:
 *   <hlm-dialog *ngIf="showCreate" (close)="closeCreate()" size="full-on-mobile" panelClass="max-w-3xl pb-28">…</hlm-dialog>
 *
 *   // Slide-from-edge sheet (bottom on mobile, top-right on desktop):
 *   <hlm-dialog *ngIf="showQuickActions" (close)="closeQuickActions()" size="sheet">…</hlm-dialog>
 *
 *   // Per-instance panel-shape override (e.g. smaller max-width). The
 *   // panelClass merges into the size's defaults via tailwind-merge,
 *   // last write wins.
 *   <hlm-dialog *ngIf="showPayment" (close)="close()" panelClass="max-w-md">…</hlm-dialog>
 *
 * Behaviors:
 * - cdkTrapFocus pulls focus inside the panel on mount; Tab cycles
 *   through focusable descendants and never escapes the modal.
 * - keydown.escape inside the panel → emits close.
 * - Click on backdrop → emits close.
 * - Body overflow is set to hidden while the dialog is mounted and
 *   restored on destroy.
 *
 * Z-index:
 * - size=default / full-on-mobile: z-[200] (above page chrome, above
 *   reservations-new's mobile CTA bar z-[220]? No — at z-[200] it's
 *   BELOW the CTA bar, which is intentional: opening a page modal on
 *   reservations-new shouldn't cover the staff's hold-countdown CTA).
 * - size=sheet: z-[300] (the quick-actions sheet MUST sit above page
 *   modals AND above reservations-new's CTA bar; the original
 *   hand-rolled version sat at z-[300] for the same reason — see the
 *   pre-migration comment in topbar.html).
 */
const wrapperVariants = cva('fixed inset-0', {
  variants: {
    size: {
      default: 'z-[200] flex items-center justify-center',
      'full-on-mobile': 'z-[200] flex items-center justify-center',
      sheet:
        'z-[300] flex items-end justify-center p-0 sm:items-start sm:justify-end sm:p-4 sm:pt-[68px]',
    },
  },
  defaultVariants: { size: 'default' },
});

const panelVariants = cva(
  'relative overflow-y-auto overflow-x-hidden bg-card p-4 shadow-2xl md:p-6',
  {
    variants: {
      size: {
        default: 'max-h-[92dvh] w-[92vw] max-w-2xl rounded-2xl',
        'full-on-mobile':
          'h-full w-full md:h-auto md:max-h-[92dvh] md:w-[92vw] md:max-w-2xl md:rounded-2xl',
        sheet:
          'w-full rounded-t-2xl border border-brand-100 sm:w-[360px] sm:rounded-2xl',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export type DialogVariants = VariantProps<typeof panelVariants>;

@Component({
  selector: 'hlm-dialog',
  standalone: true,
  imports: [CommonModule, A11yModule],
  template: `
    <div
      [class]="wrapperClasses()"
      cdkTrapFocus
      cdkTrapFocusAutoCapture
      (keydown.escape)="close.emit()"
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="ariaLabelledBy() || null"
      [attr.aria-label]="ariaLabel() || null"
    >
      <div class="absolute inset-0 bg-black/50" (click)="close.emit()"></div>
      <section [class]="panelClasses()">
        <ng-content />
      </section>
    </div>
  `,
})
export class HlmDialog implements OnDestroy {
  public readonly close = output<void>();
  public readonly size = input<DialogVariants['size']>('default');
  public readonly panelClass = input<string>('');
  public readonly ariaLabelledBy = input<string>('');
  public readonly ariaLabel = input<string>('');

  protected readonly wrapperClasses = computed(() =>
    wrapperVariants({ size: this.size() }),
  );

  protected readonly panelClasses = computed(() =>
    twMerge(panelVariants({ size: this.size() }), this.panelClass()),
  );

  private readonly doc = inject(DOCUMENT);
  private readonly previousHtmlOverflow: string;
  private readonly previousBodyOverflow: string;

  constructor() {
    // Lock both html and body to cover both scroll-container configurations
    // (html-owned vs body-owned). Today html owns the scroll (styles.scss:
    // overflow-x on html, none on body), but historically body did — keeping
    // both writes makes the lock robust to that choice changing again.
    this.previousHtmlOverflow = this.doc.documentElement.style.overflow;
    this.previousBodyOverflow = this.doc.body.style.overflow;
    this.doc.documentElement.style.overflow = 'hidden';
    this.doc.body.style.overflow = 'hidden';
  }

  ngOnDestroy(): void {
    this.doc.documentElement.style.overflow = this.previousHtmlOverflow;
    this.doc.body.style.overflow = this.previousBodyOverflow;
  }
}
