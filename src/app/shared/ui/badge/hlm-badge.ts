import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style badge directive. Applies a status-pill class set to the host.
 * Use on a <span> (most common) or any inline element via the `hlmBadge`
 * attribute.
 *
 * @example
 *   <span hlmBadge>Total</span>
 *   <span hlmBadge variant="success">PAID</span>
 *   <span hlmBadge variant="warning">DUE SOON</span>
 *   <span hlmBadge variant="danger">OVERDUE</span>
 *   <span hlmBadge variant="outline">PENDING</span>
 *
 * Variants:
 * - default: bg-primary (brand-900) — strong emphasis, rare
 * - secondary: bg-secondary (brand-100) — neutral state, common default
 * - outline: transparent bg with border-current — inherits parent text color
 *   (replaces the existing `border-current` pattern inside colored cards)
 * - destructive: bg-destructive (danger-700) — strong error emphasis
 * - success / warning / danger: tinted status pills matching the app
 *   palette (success-100/700, warning-100/800, danger-100/800). These
 *   replace the most common hand-rolled patterns:
 *     `bg-success-100 text-success-800 border-success-200`
 *     `bg-warning-100 text-warning-800 border-warning-300`
 *     `bg-danger-100 text-danger-800 border-danger-200`
 *
 * Sizes:
 * - default: text-xs h-7 px-2.5  — matches most existing pills
 * - sm: text-[11px] h-6 px-2     — for dense tables / lists
 * - xs: text-[10px] h-5 px-1.5   — history badges, inline meta
 *
 * Consumer classes merge via tailwind-merge, same as HlmButton.
 */
export const badgeVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-full border font-semibold uppercase tracking-[0.08em] transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary:
          'border-brand-200 bg-secondary text-secondary-foreground',
        outline: 'border-current bg-transparent',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground',
        success: 'border-success-200 bg-success-100 text-success-800',
        warning: 'border-warning-300 bg-warning-100 text-warning-800',
        danger: 'border-danger-200 bg-danger-100 text-danger-800',
      },
      size: {
        default: 'h-7 px-2.5 text-xs',
        sm: 'h-6 px-2 text-[11px]',
        xs: 'h-5 px-1.5 text-[10px]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;

@Directive({
  selector: '[hlmBadge]',
  exportAs: 'hlmBadge',
  standalone: true,
})
export class HlmBadge {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly variant = input<BadgeVariants['variant']>('secondary');
  public readonly size = input<BadgeVariants['size']>('default');

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = badgeVariants({
        variant: this.variant(),
        size: this.size(),
      });
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(variantClasses, this.consumerClasses),
      );
    });
  }
}
