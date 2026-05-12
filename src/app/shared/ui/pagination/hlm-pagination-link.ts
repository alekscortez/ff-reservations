import { Directive, ElementRef, booleanAttribute, effect, inject, input } from '@angular/core';
import { twMerge } from 'tailwind-merge';

import { buttonVariants, type ButtonVariants } from '../button/hlm-button';

/**
 * Apply to a <button> (or <a>) that represents a single page number /
 * prev / next slot. Visual is the same as `HlmButton` — `ghost` when
 * inactive, `outline` when active. Active state also sets
 * `aria-current="page"`.
 *
 * @example
 *   <button hlmPaginationLink [isActive]="page === current()" (click)="goTo(page)">
 *     {{ page }}
 *   </button>
 */
@Directive({
  selector: 'button[hlmPaginationLink], a[hlmPaginationLink]',
  exportAs: 'hlmPaginationLink',
  standalone: true,
  host: {
    'data-slot': 'pagination-link',
    '[attr.data-active]': 'isActive() ? "true" : null',
    '[attr.aria-current]': 'isActive() ? "page" : null',
  },
})
export class HlmPaginationLink {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly isActive = input<boolean, boolean | string>(false, {
    transform: booleanAttribute,
  });
  public readonly size = input<ButtonVariants['size']>('icon-sm');

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = buttonVariants({
        variant: this.isActive() ? 'outline' : 'ghost',
        size: this.size(),
      });
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(variantClasses, this.consumerClasses),
      );
    });
  }
}
