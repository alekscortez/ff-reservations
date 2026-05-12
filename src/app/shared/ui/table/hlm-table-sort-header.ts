import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp, lucideArrowUpDown } from '@ng-icons/lucide';
import type { Column } from '@tanstack/angular-table';

import { HlmButton } from '../button';

/**
 * Sortable column-header button. Click to toggle asc → desc → unsorted
 * for the bound TanStack column. Renders an up / down / up-down arrow
 * icon driven by `column.getIsSorted()`.
 *
 * @example
 *   <hlm-table-sort-header [column]="column('name')!" label="Name" />
 *
 * The wrapping `<th hlmTh>` should remain in the consumer template;
 * this component renders only the button + icon.
 *
 * Default change detection (not OnPush) is intentional: column methods
 * like `getIsSorted()` are TanStack-proxied and don't propagate signal
 * reads through an Angular OnPush boundary, so we let CD re-evaluate
 * the template on every event tick. The cost is negligible (one button)
 * and the alternative would require either Spartan-style
 * `injectFlexRenderContext` or passing the sorting signal as an input.
 */
@Component({
  selector: 'hlm-table-sort-header',
  standalone: true,
  imports: [HlmButton, NgIcon],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp, lucideArrowUpDown })],
  template: `
    <button
      hlmBtn
      variant="ghost"
      size="sm"
      type="button"
      class="-ml-2 h-8 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-500 data-[sorted]:text-brand-700"
      [attr.aria-label]="ariaLabel()"
      [attr.data-sorted]="sortedAttr()"
      (click)="toggle()"
    >
      <span>{{ label() }}</span>
      <ng-icon [name]="iconName()" size="14" class="ml-1.5" />
    </button>
  `,
})
export class HlmTableSortHeader<TData = unknown, TValue = unknown> {
  public readonly column = input.required<Column<TData, TValue>>();
  public readonly label = input.required<string>();

  iconName(): string {
    const s = this.column().getIsSorted();
    if (s === 'asc') return 'lucideArrowUp';
    if (s === 'desc') return 'lucideArrowDown';
    return 'lucideArrowUpDown';
  }

  sortedAttr(): string | null {
    return this.column().getIsSorted() ? '' : null;
  }

  ariaLabel(): string {
    const s = this.column().getIsSorted();
    if (s === 'asc') return `Sort ${this.label()} descending`;
    if (s === 'desc') return `Clear sort on ${this.label()}`;
    return `Sort ${this.label()} ascending`;
  }

  toggle(): void {
    const col = this.column();
    const s = col.getIsSorted();
    if (s === false) col.toggleSorting(false); // unsorted → asc
    else if (s === 'asc') col.toggleSorting(true); // asc → desc
    else col.clearSorting(); // desc → unsorted
  }
}
