import { CdkMenuItemCheckbox } from '@angular/cdk/menu';
import { Component, booleanAttribute, inject, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';

/**
 * Toggleable menu item with a leading checkmark indicator. Use inside
 * `[hlmMenu]` for column-visibility toggles, filter chips inside a
 * menu, or any "many-of-many" picker.
 *
 * @example
 *   <button hlmMenuCheckbox
 *     [checked]="isVisible('name')"
 *     (triggered)="toggleVisible('name')">
 *     Name
 *   </button>
 *
 * `checked` is two-way-able via `[(checked)]` if your state is a
 * `WritableSignal<boolean>`. Behavior:
 * - `(triggered)` fires on click + Enter/Space.
 * - Menu stays open on click so multiple toggles work without
 *   reopening (CDK's default for `cdkMenuItemCheckbox`).
 */
@Component({
  selector: 'button[hlmMenuCheckbox]',
  standalone: true,
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck })],
  hostDirectives: [
    {
      directive: CdkMenuItemCheckbox,
      inputs: ['cdkMenuItemChecked: checked'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
  ],
  host: {
    'data-slot': 'menu-checkbox-item',
    type: 'button',
    class:
      'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-brand-900 outline-none transition-colors hover:bg-brand-100 focus:bg-brand-100 disabled:pointer-events-none disabled:opacity-50',
  },
  template: `
    <span class="pointer-events-none absolute left-2 flex h-3.5 w-3.5 items-center justify-center text-brand-700">
      @if (menuItem.checked) {
        <ng-icon name="lucideCheck" size="14" />
      }
    </span>
    <ng-content />
  `,
})
export class HlmMenuCheckbox {
  /** Mirrors `CdkMenuItemCheckbox.checked` — declared for type narrowing only. */
  public readonly checked = input(false, { transform: booleanAttribute });
  protected readonly menuItem = inject(CdkMenuItemCheckbox);
}
