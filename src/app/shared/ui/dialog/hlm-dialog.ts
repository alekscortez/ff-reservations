import { Component, OnDestroy, inject, output } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';

/**
 * Spartan-style modal dialog using Angular CDK for focus trap +
 * Escape handling + backdrop click → close. Caller controls
 * open/close state with *ngIf; the dialog emits `close` for any
 * "should dismiss" intent.
 *
 * @example
 *   // In template:
 *   <hlm-dialog *ngIf="showModal" (close)="showModal = false">
 *     <h3>Confirm action</h3>
 *     <p>Are you sure?</p>
 *     <button hlmBtn (click)="confirm()">Yes</button>
 *   </hlm-dialog>
 *
 *   // Component just toggles showModal — no openDialog() service call.
 *
 * Behaviors:
 * - cdkTrapFocus pulls focus inside the panel on mount; Tab cycles
 *   through focusable descendants and never escapes the modal.
 * - keydown.escape inside the panel → emits close.
 * - Click on backdrop → emits close.
 * - Body overflow is set to hidden while the dialog is mounted and
 *   restored on destroy (mirrors the existing
 *   .reservations-new-workspace-lock pattern without needing CSS).
 *
 * Future variants (when needed): `level` input for z-index (120/200/300),
 * `size` input for max-width, `position` input for centered vs sheet
 * (slide from edge). For v1, keep it boring — only one shape.
 */
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
      <section
        class="relative max-h-[92dvh] w-[92vw] max-w-2xl overflow-y-auto overflow-x-hidden rounded-2xl bg-card p-4 shadow-2xl md:p-6"
      >
        <ng-content />
      </section>
    </div>
  `,
})
export class HlmDialog implements OnDestroy {
  public readonly close = output<void>();

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
