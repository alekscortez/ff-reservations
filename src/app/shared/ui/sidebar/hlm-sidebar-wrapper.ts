import { Directive, ElementRef, computed, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

import { HlmSidebarService } from './hlm-sidebar.service';

/**
 * Root layout wrapper for the sticky-header sidebar shell. Applies the
 * `group` class + `data-state` attribute that all downstream components
 * (HlmSidebar / HlmSidebarInset / etc.) hook into via `group-data-[…]:`
 * variants. Use on the outermost element of your shell template:
 *
 *   <div hlmSidebarWrapper>
 *     <site-header />
 *     <main hlmSidebarInset> ... </main>
 *   </div>
 *
 * Variants:
 *   - flex-col: stack header above the (sidebar + main) row (default)
 *   - flex-row: sidebar to the left of (header + main) — not used today
 */
@Directive({
  selector: '[hlmSidebarWrapper]',
  exportAs: 'hlmSidebarWrapper',
  standalone: true,
  host: {
    '[attr.data-state]': '_state()',
    '[attr.data-side]': '"left"',
  },
})
export class HlmSidebarWrapper {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly service = inject(HlmSidebarService);

  protected readonly _state = computed(() => this.service.state());

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      // Drop into the data-attribute scope used by descendant `group-data-[…]:`
      // variants. The shell template should add `group/sidebar-wrapper` here
      // or via the consumer's class list — we don't add it ourselves so the
      // group name stays explicit.
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('group/sidebar-wrapper flex min-h-svh w-full', this.consumerClasses),
      );
    });
  }
}
