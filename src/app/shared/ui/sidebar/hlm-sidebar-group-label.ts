import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Group label / section heading. Renders as a small uppercase
 * tracked-out label above an `<ul hlmSidebarMenu>`.
 *
 *   <hlm-sidebar-group-label>Staff</hlm-sidebar-group-label>
 */
@Directive({
  selector: 'hlm-sidebar-group-label, [hlmSidebarGroupLabel]',
  exportAs: 'hlmSidebarGroupLabel',
  standalone: true,
  host: { 'data-slot': 'sidebar-group-label' },
})
export class HlmSidebarGroupLabel {
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
          'flex h-7 shrink-0 items-center px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/60',
          this.consumerClasses,
        ),
      );
    });
  }
}
