import { Directive, computed, input } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style popover content wrapper. Apply to the element rendered
 * inside an `<ng-template brnPopoverContent>` to style the overlay body
 * (white card, brand border, shadow, padding, rounded corners).
 *
 * @example
 *   <brn-popover sideOffset="6">
 *     <button brnPopoverTrigger hlmBtn variant="outline">Open</button>
 *     <ng-template brnPopoverContent>
 *       <div hlmPopoverContent class="w-64">Hello</div>
 *     </ng-template>
 *   </brn-popover>
 *
 * Pass extra classes via the `class` attribute — they merge over the
 * defaults via tailwind-merge, so consumer utilities win on conflict
 * (e.g. `class="w-72 p-3"` overrides the default width/padding).
 *
 * Z-index: defaults to z-[210] so a popover opened inside an HlmDialog
 * (z-[200] for default size) sits above the dialog backdrop.
 */
@Directive({
  selector: '[hlmPopoverContent]',
  standalone: true,
  host: {
    '[class]': 'classes()',
    'role': 'dialog',
  },
})
export class HlmPopoverContent {
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly classes = computed(() =>
    twMerge(
      'z-[210] w-72 rounded-md border border-brand-200 bg-white p-4 text-brand-900 shadow-lg outline-none',
      this.extraClass(),
    ),
  );
}
