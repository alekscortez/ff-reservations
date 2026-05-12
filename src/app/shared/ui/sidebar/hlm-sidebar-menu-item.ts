import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * `<li>` styling. Just a relative-positioned list item — most of the
 * visual weight lives on the nested `<a hlmSidebarMenuButton>`.
 */
@Directive({
  selector: 'li[hlmSidebarMenuItem]',
  exportAs: 'hlmSidebarMenuItem',
  standalone: true,
  host: { 'data-slot': 'sidebar-menu-item' },
})
export class HlmSidebarMenuItem {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      this.el.nativeElement.setAttribute(
        'class',
        twMerge('relative', this.consumerClasses),
      );
    });
  }
}
