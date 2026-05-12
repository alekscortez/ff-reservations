import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * `<ul>` styling for a sidebar menu. Contains `<li hlmSidebarMenuItem>`
 * children with `<a hlmSidebarMenuButton>` (or `<button hlmSidebarMenuButton>`)
 * inside.
 */
@Directive({
  selector: 'ul[hlmSidebarMenu]',
  exportAs: 'hlmSidebarMenu',
  standalone: true,
  host: { 'data-slot': 'sidebar-menu' },
})
export class HlmSidebarMenu {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('flex w-full min-w-0 flex-col gap-1 list-none p-0', this.consumerClasses),
      );
    });
  }
}
