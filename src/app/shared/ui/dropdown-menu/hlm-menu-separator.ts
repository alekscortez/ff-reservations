import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Visual divider between menu sections. Renders a 1px line with the
 * project's brand border tint. Use sparingly — most menus need only
 * one separator (between primary actions and destructive ones).
 *
 * @example
 *   <button hlmMenuItem (click)="edit()">Edit</button>
 *   <hlm-menu-separator />
 *   <button hlmMenuItem variant="destructive" (click)="delete()">Delete</button>
 */
@Component({
  selector: 'hlm-menu-separator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'menu-separator',
    role: 'separator',
    'aria-orientation': 'horizontal',
    class: '-mx-1 my-1 block h-px bg-brand-100',
  },
  template: '',
})
export class HlmMenuSeparator {}
