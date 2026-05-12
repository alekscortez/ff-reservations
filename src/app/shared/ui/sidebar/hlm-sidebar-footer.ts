import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Bottom slot of the sidebar. Use for the user chip + logout, support
 * links, etc. Pins to the bottom edge so it stays in view as the content
 * area scrolls.
 */
@Directive({
  selector: 'hlm-sidebar-footer, [hlmSidebarFooter]',
  exportAs: 'hlmSidebarFooter',
  standalone: true,
  host: { 'data-slot': 'sidebar-footer' },
})
export class HlmSidebarFooter {
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
          'flex flex-col gap-2 border-t border-sidebar-border p-3',
          this.consumerClasses,
        ),
      );
    });
  }
}
