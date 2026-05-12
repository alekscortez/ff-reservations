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
          // No `border-t` — Spartan's nav-user pattern relies on the
          // chip's own visual weight + padding for separation, not a
          // divider line. Restore a top border if you ever swap the
          // chip back to a hand-rolled label + button block.
          'flex flex-col gap-2 p-3',
          this.consumerClasses,
        ),
      );
    });
  }
}
