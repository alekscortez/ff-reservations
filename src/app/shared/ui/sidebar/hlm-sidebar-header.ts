import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Top slot of the sidebar. Use for the brand chip / org switcher.
 * Sticky at the top edge so it stays in view as the content scrolls.
 */
@Directive({
  selector: 'hlm-sidebar-header, [hlmSidebarHeader]',
  exportAs: 'hlmSidebarHeader',
  standalone: true,
  host: { 'data-slot': 'sidebar-header' },
})
export class HlmSidebarHeader {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('flex flex-col gap-2 p-3', this.consumerClasses),
      );
    });
  }
}
