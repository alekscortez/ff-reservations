import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style pagination root. Apply to a <nav> wrapping the
 * pagination controls. Sets `role="navigation"` + aria-label so the
 * list of page buttons is announced as a single navigation landmark.
 *
 * @example
 *   <nav hlmPagination aria-label="Clients pagination">
 *     <ul hlmPaginationContent>...</ul>
 *   </nav>
 *
 * Pair with the high-level `<hlm-numbered-pagination>` for the common
 * "previous / 1 2 … N / next" UX. The low-level pieces
 * (`hlmPaginationContent`, `hlmPaginationItem`, `hlmPaginationLink`,
 * `<hlm-pagination-previous>`, `<hlm-pagination-next>`,
 * `<hlm-pagination-ellipsis>`) are exported in case a caller needs to
 * compose a custom layout.
 */
@Directive({
  selector: 'nav[hlmPagination]',
  exportAs: 'hlmPagination',
  standalone: true,
  host: {
    role: 'navigation',
    'data-slot': 'pagination',
    '[attr.aria-label]': 'ariaLabel()',
  },
})
export class HlmPagination {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly ariaLabel = input<string>('pagination', { alias: 'aria-label' });

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('mx-auto flex w-full justify-center', this.consumerClasses),
      );
    });
  }
}
