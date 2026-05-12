import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Apply to the `<main>` (or any block) that should fill the remaining
 * row width next to `<hlm-sidebar>`. The sidebar's gap div reserves
 * its own layout width — the inset just flex-grows into whatever's
 * left. When the sidebar's gap collapses to w-0, this inset
 * automatically expands to full width via standard flex sizing.
 *
 * Pair with `<hlm-sidebar>` as a flex sibling in the row inside
 * `[hlmSidebarWrapper]`.
 */
@Directive({
  selector: '[hlmSidebarInset]',
  exportAs: 'hlmSidebarInset',
  standalone: true,
})
export class HlmSidebarInset {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(
          'relative flex w-full flex-1 flex-col bg-background',
          this.consumerClasses,
        ),
      );
    });
  }
}
