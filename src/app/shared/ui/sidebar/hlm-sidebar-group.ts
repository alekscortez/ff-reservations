import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * A named nav section. Pair with `<hlm-sidebar-group-label>` for the
 * heading + an `<ul hlmSidebarMenu>` for the items.
 *
 *   <hlm-sidebar-group>
 *     <hlm-sidebar-group-label>Staff</hlm-sidebar-group-label>
 *     <ul hlmSidebarMenu> ... </ul>
 *   </hlm-sidebar-group>
 */
@Directive({
  selector: 'hlm-sidebar-group, [hlmSidebarGroup]',
  exportAs: 'hlmSidebarGroup',
  standalone: true,
  host: { 'data-slot': 'sidebar-group' },
})
export class HlmSidebarGroup {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('flex w-full min-w-0 flex-col gap-1', this.consumerClasses),
      );
    });
  }
}
