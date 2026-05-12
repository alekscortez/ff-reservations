import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Apply to the `<main>` (or whatever you use for the main content
 * column). Reserves left padding equal to the sidebar's desktop width
 * when the sidebar is expanded; collapses to 0 when the sidebar is
 * collapsed. On mobile, padding is always 0 (the sidebar slides over
 * via portal instead of taking layout space).
 *
 * Pair with `<hlm-sidebar>` inside the same `[hlmSidebarWrapper]` root.
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
          'relative flex flex-1 flex-col bg-background md:pl-64 group-data-[state=collapsed]/sidebar-wrapper:md:pl-0',
          this.consumerClasses,
        ),
      );
    });
  }
}
