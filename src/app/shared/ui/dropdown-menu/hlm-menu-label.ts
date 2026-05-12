import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Non-interactive label rendered above a group of menu items. Use this
 * for "Actions", "Status", etc. — anything that isn't itself clickable.
 *
 * @example
 *   <div hlmMenuLabel>Actions</div>
 *   <button hlmMenuItem (click)="...">Edit</button>
 */
@Directive({
  selector: '[hlmMenuLabel]',
  exportAs: 'hlmMenuLabel',
  standalone: true,
  host: { 'data-slot': 'menu-label' },
})
export class HlmMenuLabel {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let consumerClasses: string | null = null;
    effect(() => {
      if (consumerClasses === null) {
        consumerClasses = el.getAttribute('class') ?? '';
      }
      el.setAttribute(
        'class',
        twMerge(
          'px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-brand-500',
          consumerClasses,
        ),
      );
    });
  }
}
