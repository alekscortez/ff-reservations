import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Scrollable middle slot of the sidebar — for nav groups, menus,
 * etc. Takes the remaining vertical space between header and footer.
 */
@Directive({
  selector: 'hlm-sidebar-content, [hlmSidebarContent]',
  exportAs: 'hlmSidebarContent',
  standalone: true,
  host: { 'data-slot': 'sidebar-content' },
})
export class HlmSidebarContent {
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
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3',
          this.consumerClasses,
        ),
      );
    });
  }
}
