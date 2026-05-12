import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style input directive. Applies a Tailwind-driven class set
 * to the host element. Use on a native <input>, <select>, or
 * <textarea> via the `hlmInput` attribute.
 *
 * @example
 *   <input hlmInput type="email" formControlName="email" placeholder="…" />
 *   <select hlmInput formControlName="role">…</select>
 *   <textarea hlmInput formControlName="notes" rows="3"></textarea>
 *
 * Variants:
 * - default: h-10 (matches the dominant existing pattern)
 * - sm: h-9 (for dense inline rows / table cells)
 * - lg: h-11 (for primary form fields with larger touch targets)
 *
 * The base classes use shadcn semantic tokens (border-input,
 * bg-background, text-foreground, placeholder:text-muted-foreground,
 * focus:border-ring) so the appearance updates if the theme palette in
 * styles.scss changes. Consumer classes merge via tailwind-merge,
 * same as HlmButton/HlmBadge.
 *
 * Mobile-zoom-prevention: NO `text-base` in the variant — the global
 * `@media (hover: none) and (pointer: coarse)` rule in styles.scss
 * already forces 16px font-size on focused inputs, so iOS Safari's
 * focus-zoom is already mitigated globally. Specifying text-base in
 * the variant would just be redundant and slightly larger on desktop.
 */
export const inputVariants = cva(
  'flex w-full rounded-lg border border-input bg-background px-3 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring disabled:cursor-not-allowed disabled:opacity-50 readonly:bg-muted',
  {
    variants: {
      size: {
        default: 'h-10 text-sm',
        sm: 'h-9 text-xs',
        lg: 'h-11 text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export type InputVariants = VariantProps<typeof inputVariants>;

@Directive({
  selector: 'input[hlmInput], select[hlmInput], textarea[hlmInput]',
  exportAs: 'hlmInput',
  standalone: true,
})
export class HlmInput {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly size = input<InputVariants['size']>('default');

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = inputVariants({ size: this.size() });
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(variantClasses, this.consumerClasses),
      );
    });
  }
}
