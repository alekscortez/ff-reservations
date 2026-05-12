import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronLeft } from '@ng-icons/lucide';

import { HlmPaginationLink } from './hlm-pagination-link';
import type { ButtonVariants } from '../button/hlm-button';

/**
 * Previous-page button. Renders a chevron + the word "Previous" on
 * wider screens; icon-only on mobile (or when `iconOnly` is set).
 *
 * @example
 *   <li hlmPaginationItem>
 *     <hlm-pagination-previous (click)="prev()" />
 *   </li>
 */
@Component({
  selector: 'hlm-pagination-previous',
  standalone: true,
  imports: [HlmPaginationLink, NgIcon],
  providers: [provideIcons({ lucideChevronLeft })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      hlmPaginationLink
      type="button"
      [size]="_size()"
      [attr.aria-label]="ariaLabel()"
      class="gap-1"
    >
      <ng-icon name="lucideChevronLeft" size="16" />
      <span [class]="_labelClass()">{{ text() }}</span>
    </button>
  `,
})
export class HlmPaginationPrevious {
  public readonly ariaLabel = input<string>('Go to previous page', { alias: 'aria-label' });
  public readonly text = input<string>('Previous');
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
