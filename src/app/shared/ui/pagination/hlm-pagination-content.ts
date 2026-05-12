import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Apply to a <ul> immediately inside [hlmPagination]. Lays out the
 * page-button list as a flex row with a small gap.
 */
@Directive({
  selector: 'ul[hlmPaginationContent]',
  exportAs: 'hlmPaginationContent',
  standalone: true,
  host: {
    'data-slot': 'pagination-content',
  },
})
export class HlmPaginationContent {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('flex flex-row items-center gap-1', this.consumerClasses),
      );
    });
  }
}
