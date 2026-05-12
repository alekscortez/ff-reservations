import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style alert / banner component for transient messages with a
 * tinted background + border + text color set. Use for inline error,
 * success, and warning callouts.
 *
 * @example
 *   <hlm-alert variant="destructive" *ngIf="error">{{ error }}</hlm-alert>
 *   <hlm-alert variant="success" *ngIf="notice">{{ notice }}</hlm-alert>
 *   <hlm-alert variant="warning">
 *     <strong>Heads up:</strong> double-check the payment deadline.
 *   </hlm-alert>
 *
 * Variants:
 * - info: brand neutral (rare; muted card-like callout)
 * - success: green tint
 * - warning: amber tint
 * - destructive: red tint (default for errors)
 *
 * For tighter / smaller alert sizes pass consumer classes (e.g.
 * `class="text-xs"` or `class="px-2 py-1"`). The base sets `text-sm
 * rounded-lg px-3 py-2` which matches the most common existing pattern
 * (`rounded-lg border border-{color}-200 bg-{color}-50 px-3 py-2
 * text-sm text-{color}-700`).
 */
export const alertVariants = cva(
  'rounded-lg border px-3 py-2 text-sm',
  {
    variants: {
      variant: {
        info: 'border-brand-200 bg-brand-50 text-brand-700',
        success: 'border-success-200 bg-success-50 text-success-700',
        warning: 'border-warning-300 bg-warning-50 text-warning-800',
        destructive: 'border-danger-200 bg-danger-50 text-danger-700',
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  },
);

export type AlertVariants = VariantProps<typeof alertVariants>;

@Component({
  selector: 'hlm-alert',
  standalone: true,
  imports: [CommonModule],
  template: `<div [class]="classes()" role="alert"><ng-content /></div>`,
})
export class HlmAlert {
  public readonly variant = input<AlertVariants['variant']>('info');
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly classes = computed(() =>
    twMerge(alertVariants({ variant: this.variant() }), this.extraClass()),
  );
}
