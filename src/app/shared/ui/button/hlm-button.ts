import { Directive, input, computed } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style button directive. Applies a Tailwind-driven class set to the
 * host element. Use on a native <button> or <a> via the `hlmBtn` attribute.
 *
 * @example
 *   <button hlmBtn>Save</button>
 *   <button hlmBtn variant="outline" size="sm">Cancel</button>
 *   <button hlmBtn variant="destructive">Delete</button>
 *
 * Variants resolve against the shadcn semantic theme tokens in styles.scss
 * (--primary, --destructive, --muted, --foreground). To override on a
 * per-instance basis, pass extra classes via [class] — tailwind-merge
 * dedupes conflicts (last write wins).
 *
 * No @spartan-ng/brain dependency: a native <button> already handles
 * disabled/focus/Enter+Space correctly. Brain becomes useful for
 * compound widgets (dialog, select, popover) where CDK overlay or
 * focus-trap behaviors are required.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/90',
        outline:
          'border border-input bg-background text-foreground hover:bg-muted active:bg-muted',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/80',
        ghost:
          'text-foreground hover:bg-muted active:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/90',
        link: 'text-foreground underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        xs: 'h-7 px-2 text-xs',
        sm: 'h-9 px-3 text-xs',
        lg: 'h-11 px-5 text-sm',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

@Directive({
  selector: 'button[hlmBtn], a[hlmBtn]',
  exportAs: 'hlmBtn',
  standalone: true,
  host: {
    '[class]': 'computedClasses()',
  },
})
export class HlmButton {
  public readonly variant = input<ButtonVariants['variant']>('default');
  public readonly size = input<ButtonVariants['size']>('default');

  protected readonly computedClasses = computed(() =>
    twMerge(buttonVariants({ variant: this.variant(), size: this.size() })),
  );
}
