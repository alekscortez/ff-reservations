import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Thin horizontal divider between groups inside the sidebar. Render
 * inside `<hlm-sidebar-content>` between `<hlm-sidebar-group>`s.
 */
@Directive({
  selector: 'hlm-sidebar-separator, [hlmSidebarSeparator]',
  exportAs: 'hlmSidebarSeparator',
  standalone: true,
  host: { 'data-slot': 'sidebar-separator', role: 'separator' },
})
export class HlmSidebarSeparator {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('mx-2 my-1 h-px shrink-0 bg-sidebar-border', this.consumerClasses),
      );
    });
  }
}
