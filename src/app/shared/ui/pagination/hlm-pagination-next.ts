import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight } from '@ng-icons/lucide';

import { HlmPaginationLink } from './hlm-pagination-link';
import type { ButtonVariants } from '../button/hlm-button';

/**
 * Next-page button. Mirror of `HlmPaginationPrevious`.
 *
 * @example
 *   <li hlmPaginationItem>
 *     <hlm-pagination-next (click)="next()" />
 *   </li>
 */
@Component({
  selector: 'hlm-pagination-next',
  standalone: true,
  imports: [HlmPaginationLink, NgIcon],
  providers: [provideIcons({ lucideChevronRight })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      hlmPaginationLink
      type="button"
      [size]="_size()"
      [attr.aria-label]="ariaLabel()"
      class="gap-1"
    >
      <span [class]="_labelClass()">{{ text() }}</span>
      <ng-icon name="lucideChevronRight" size="16" />
    </button>
  `,
})
export class HlmPaginationNext {
  public readonly ariaLabel = input<string>('Go to next page', { alias: 'aria-label' });
  public readonly text = input<string>('Next');
  public readonly iconOnly = input<boolean, boolean | string>(false, {
    transform: booleanAttribute,
  });

  protected readonly _labelClass = computed(() =>
    this.iconOnly() ? 'sr-only' : 'hidden sm:inline',
  );
  protected readonly _size = computed<ButtonVariants['size']>(() =>
    this.iconOnly() ? 'icon-sm' : 'sm',
  );
}
