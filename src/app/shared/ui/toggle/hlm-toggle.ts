import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style toggle-pill directive. Used for selectable inline
 * chips (view-mode toggles, section/table selectors, filter chips).
 * NOT a generic action button — use HlmButton for those.
 *
 * State is controller-driven via [active]; the directive just applies
 * the right Tailwind classes for that state.
 *
 * @example
 *   // View-mode toggle (filled, no border):
 *   <button hlmToggle [active]="viewMode === 'MAP'" (click)="setViewMode('MAP')">Map</button>
 *   <button hlmToggle [active]="viewMode === 'LIST'" (click)="setViewMode('LIST')">List</button>
 *
 *   // Multi-select chip (outline with border):
 *   <button hlmToggle variant="outline" [active]="isSelected(tableId)" (click)="toggle(tableId)">A04</button>
 *
 * Variants:
 * - default: no border, transparent inactive, bg-primary active. Used
 *   for high-contrast view-mode switchers (Map vs List).
 * - outline: border-input inactive, border-primary + bg-primary active.
 *   Used for multi-select chips where many can be selected. Also used
 *   for "disable table" toggles where the active state inverts the
 *   element (light → dark slate).
 * - warning: amber-themed (border-warning + bg-warning-100 inactive,
 *   bg-warning-800 active). Used for cautionary multi-select chips
 *   (e.g. "frequent client not coming" toggles in event editor).
 */
export const toggleVariants = cva(
  'inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: '',
        outline: 'border',
        warning: 'border',
      },
      active: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      // default (no border)
      { variant: 'default', active: false, class: 'text-foreground hover:bg-muted' },
      { variant: 'default', active: true, class: 'bg-primary text-primary-foreground' },
      // outline (with border)
      {
        variant: 'outline',
        active: false,
        class: 'border-input bg-background text-foreground hover:bg-muted',
      },
      {
        variant: 'outline',
        active: true,
        class: 'border-primary bg-primary text-primary-foreground',
      },
      // warning (amber)
      {
        variant: 'warning',
        active: false,
        class: 'border-warning-300 bg-warning-100 text-warning-800 hover:bg-warning-200',
      },
      {
        variant: 'warning',
        active: true,
        class: 'border-warning-800 bg-warning-800 text-warning-50',
      },
    ],
    defaultVariants: {
      variant: 'default',
      active: false,
    },
  },
);

export type ToggleVariants = VariantProps<typeof toggleVariants>;

@Directive({
  selector: 'button[hlmToggle]',
  exportAs: 'hlmToggle',
  standalone: true,
})
export class HlmToggle {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly variant = input<ToggleVariants['variant']>('default');
  public readonly active = input<ToggleVariants['active']>(false);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = toggleVariants({
        variant: this.variant(),
        active: this.active(),
      });
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(variantClasses, this.consumerClasses),
      );
    });
  }
}
