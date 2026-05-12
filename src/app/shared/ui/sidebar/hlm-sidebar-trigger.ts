import { Directive, HostListener, inject } from '@angular/core';

import { HlmSidebarService } from './hlm-sidebar.service';

/**
 * Toggle button for the sidebar. Apply to a `<button>`:
 *
 *   <button hlmSidebarTrigger aria-label="Toggle sidebar"> ... </button>
 *
 * Mutates the right surface based on viewport:
 *   - mobile: opens/closes the slide-over (HlmDialog sheet)
 *   - desktop: collapses/expands the sidebar column
 *
 * Doesn't apply any visual classes — pair with `hlmBtn variant="ghost"`
 * (or any other button styling) to render. We keep the directive
 * styling-free so the trigger can live inside `hlmBtn` without two
 * directives racing on the class attribute.
 */
@Directive({
  selector: '[hlmSidebarTrigger]',
  exportAs: 'hlmSidebarTrigger',
  standalone: true,
  host: { 'data-slot': 'sidebar-trigger', type: 'button' },
})
export class HlmSidebarTrigger {
  private readonly service = inject(HlmSidebarService);

  @HostListener('click')
  onClick(): void {
    this.service.toggle();
  }
}
