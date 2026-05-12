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
 *     <button hlmBtn (click)="confirm()">Yes</button>
 *   </hlm-dialog>
 *
 *   // Full-screen on mobile, centered on desktop. Used for long forms
 *   // that need the full viewport on small screens (e.g. multi-step
 *   // create-event, frequent-client create, hold-then-reserve flow).
 *   <hlm-dialog
 *     *ngIf="showCreate"
 *     (close)="closeCreate()"
 *     size="full-on-mobile"
 *     panelClass="max-w-3xl pb-28"
 *   >…</hlm-dialog>
 *
 *   // Custom panel shape via panelClass override (e.g. smaller max-width
 *   // for payment modal, full-height for detail modal). Classes merge
 *   // via tailwind-merge — conflicting Tailwind utilities resolve with
 *   // panelClass winning.
 *   <hlm-dialog
 *     *ngIf="showDetailModal"
 *     (close)="closeDetail()"
 *     panelClass="h-[92dvh] md:h-auto md:max-h-[92dvh]"
 *   >…</hlm-dialog>
 *
 * Behaviors:
 * - cdkTrapFocus pulls focus inside the panel on mount; Tab cycles
 *   through focusable descendants and never escapes the modal.
 * - keydown.escape inside the panel → emits close.
 * - Click on backdrop → emits close.
 * - Body overflow is set to hidden while the dialog is mounted and
 *   restored on destroy.
 *
 * Future variants (when needed): `level` input for z-index (120/200/300),
 * `position="sheet"` for slide-from-edge variants.
 */
const panelVariants = cva(
  'relative overflow-y-auto overflow-x-hidden bg-card p-4 shadow-2xl md:p-6',
  {
    variants: {
      size: {
        // Centered, fits content up to 92vw / max-w-2xl with rounded corners.
        // Backdrop click area = the surrounding flex container.
        default: 'max-h-[92dvh] w-[92vw] max-w-2xl rounded-2xl',
        // Full-screen on mobile (no rounded corners, full viewport),
        // becomes a centered dialog on md+. The pb-* bottom padding can
        // be overridden via panelClass for footer / sticky CTA spacing.
        'full-on-mobile':
          'h-full w-full md:h-auto md:max-h-[92dvh] md:w-[92vw] md:max-w-2xl md:rounded-2xl',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export type DialogVariants = VariantProps<typeof panelVariants>;

@Component({
  selector: 'hlm-dialog',
  standalone: true,
  imports: [CommonModule, A11yModule],
  template: `
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center"
      cdkTrapFocus
      cdkTrapFocusAutoCapture
      (keydown.escape)="close.emit()"
      role="dialog"
      aria-modal="true"
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

  protected readonly panelClasses = computed(() =>
    twMerge(panelVariants({ size: this.size() }), this.panelClass()),
  );

  private readonly doc = inject(DOCUMENT);
  private readonly previousBodyOverflow: string;

  constructor() {
    this.previousBodyOverflow = this.doc.body.style.overflow;
    this.doc.body.style.overflow = 'hidden';
  }

  ngOnDestroy(): void {
    this.doc.body.style.overflow = this.previousBodyOverflow;
  }
}
