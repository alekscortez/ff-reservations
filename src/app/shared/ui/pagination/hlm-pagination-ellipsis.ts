import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis } from '@ng-icons/lucide';

/**
 * Visual gap indicator between non-adjacent page numbers (e.g. "1 …
 * 14 15 16 … 28"). Not interactive — the icon is hidden from screen
 * readers and replaced with an sr-only label.
 */
@Component({
  selector: 'hlm-pagination-ellipsis',
  standalone: true,
  imports: [NgIcon],
  providers: [provideIcons({ lucideEllipsis })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'pagination-ellipsis',
    class: 'flex h-8 w-8 items-center justify-center text-brand-500',
    'aria-hidden': 'true',
  },
  template: `
    <ng-icon name="lucideEllipsis" size="16" />
    <span class="sr-only">{{ srOnlyText() }}</span>
  `,
})
export class HlmPaginationEllipsis {
  public readonly srOnlyText = input<string>('More pages');
}
