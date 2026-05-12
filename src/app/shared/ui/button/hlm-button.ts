import { Directive, ElementRef, effect, inject, input } from '@angular/core';
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
 *   <button hlmBtn class="w-full">Log out</button>  (consumer class preserved)
 *
 * Variants resolve against the shadcn semantic theme tokens in styles.scss
 * (--primary, --destructive, --muted, --foreground).
 *
 * Consumer-provided classes (e.g. w-full, my-2) merge into the variant
 * classes via tailwind-merge — if the consumer writes a class that
 * conflicts with the variant (e.g. bg-red-500 vs bg-primary), the
 * consumer's wins. The static `class` attribute is captured on first
 * render; subsequent dynamic [class.foo] bindings from outside the
 * directive are NOT merged.
 *
 * No @spartan-ng/brain dependency: a native <button> handles
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
        'icon-xs': 'h-7 w-7',
        'icon-sm': 'h-8 w-8',
        'icon-lg': 'h-12 w-12',
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
})
export class HlmButton {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly variant = input<ButtonVariants['variant']>('default');
  public readonly size = input<ButtonVariants['size']>('default');

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = buttonVariants({
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
