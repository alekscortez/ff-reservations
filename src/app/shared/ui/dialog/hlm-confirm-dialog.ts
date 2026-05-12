import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { HlmButton } from '../button';
import { HlmDialog } from './hlm-dialog';

/**
 * Tiny wrapper over HlmDialog for the common "Are you sure?" pattern.
 *
 *   <hlm-confirm-dialog
 *     *ngIf="confirming"
 *     title="Delete client?"
 *     message="This removes Maria López and their reservation history."
 *     confirmText="Delete"
 *     destructive
 *     [loading]="loading"
 *     (confirm)="runDelete()"
 *     (cancel)="confirming = null" />
 *
 * Replaces the unstyled `window.confirm()` pattern with a Spartan-
 * styled modal that respects Esc + backdrop click (via HlmDialog).
 * For prompts that need form fields, compose `<hlm-dialog>` directly
 * with custom inputs — this primitive is intentionally yes/no only.
 */
@Component({
  selector: 'hlm-confirm-dialog',
  standalone: true,
  imports: [CommonModule, HlmDialog, HlmButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog (close)="cancel.emit()" panelClass="max-w-md">
      <h3 class="text-lg font-semibold text-brand-900">{{ title }}</h3>
      <p class="mt-2 text-sm text-brand-600" *ngIf="message">{{ message }}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button hlmBtn variant="outline" type="button" [disabled]="loading" (click)="cancel.emit()">
          {{ cancelText }}
        </button>
        <button
          hlmBtn
          [variant]="destructive ? 'destructive' : 'default'"
          type="button"
          [disabled]="loading"
          (click)="confirm.emit()"
        >
          {{ loading ? loadingText : confirmText }}
        </button>
      </div>
    </hlm-dialog>
  `,
})
export class HlmConfirmDialog {
  @Input({ required: true }) title!: string;
  @Input() message: string | null = null;
  @Input() confirmText = 'Confirm';
  @Input() cancelText = 'Cancel';
  @Input() loadingText = 'Working…';
  @Input() destructive = false;
  @Input() loading = false;
  @Output() confirm = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
}
