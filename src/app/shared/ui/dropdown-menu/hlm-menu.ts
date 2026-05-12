import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { Directive, ElementRef, booleanAttribute, effect, inject, input } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style dropdown menu primitive family. Wraps `@angular/cdk/menu`
 * (overlay + portal + keyboard nav + focus management) with our styling
 * convention (effect + tailwind-merge).
 *
 * @example
 *   <button hlmBtn variant="ghost" size="icon-sm" [hlmMenuTriggerFor]="rowMenu">
 *     <ng-icon name="lucideEllipsisVertical" />
 *   </button>
 *   <ng-template #rowMenu>
 *     <div hlmMenu>
 *       <button hlmMenuItem (click)="edit()">Edit</button>
 *       <hlm-menu-separator />
 *       <button hlmMenuItem variant="destructive" (click)="delete()">Delete</button>
 *     </div>
 *   </ng-template>
 *
 * The trigger is any element you control (typically `<button hlmBtn>`).
 * The menu content lives in an `<ng-template>` and is rendered into an
 * overlay portal when the trigger opens it. CDK handles arrow-key nav,
 * Esc / outside-click dismiss, and returning focus to the trigger.
 */
function makeMergeEffect(host: HTMLElement, defaults: string) {
  let consumerClasses: string | null = null;
  return () => {
    if (consumerClasses === null) {
      consumerClasses = host.getAttribute('class') ?? '';
    }
    host.setAttribute('class', twMerge(defaults, consumerClasses));
  };
}

/** Attach to any element to make it open `<ng-template>`-defined menu content. */
@Directive({
  selector: '[hlmMenuTriggerFor]',
  exportAs: 'hlmMenuTriggerFor',
  standalone: true,
  hostDirectives: [
    {
      directive: CdkMenuTrigger,
      inputs: [
        'cdkMenuTriggerFor: hlmMenuTriggerFor',
        'cdkMenuPosition: hlmMenuPosition',
        'cdkMenuTriggerData: hlmMenuTriggerData',
      ],
      outputs: ['cdkMenuOpened: hlmMenuOpened', 'cdkMenuClosed: hlmMenuClosed'],
    },
  ],
})
export class HlmMenuTrigger {}

/** The dropdown panel. Apply inside an `<ng-template>` referenced by `[hlmMenuTriggerFor]`. */
@Directive({
  selector: '[hlmMenu]',
  exportAs: 'hlmMenu',
  standalone: true,
  hostDirectives: [CdkMenu],
  host: { 'data-slot': 'menu' },
})
export class HlmMenu {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(
      makeMergeEffect(
        el,
        'z-50 min-w-[10rem] overflow-hidden rounded-md border border-brand-200 bg-white p-1 text-sm text-brand-900 shadow-md outline-none',
      ),
    );
  }
}

/**
 * Menu item. Use `<button hlmMenuItem (click)="...">` — CdkMenuItem
 * handles keyboard activation (Enter / Space) and auto-closes the menu
 * after the click.
 */
@Directive({
  selector: 'button[hlmMenuItem], a[hlmMenuItem]',
  exportAs: 'hlmMenuItem',
  standalone: true,
  hostDirectives: [CdkMenuItem],
  host: {
    'data-slot': 'menu-item',
    type: 'button',
  },
})
export class HlmMenuItem {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  /** `destructive` renders the item in danger color (red text + red hover bg). */
  public readonly variant = input<'default' | 'destructive'>('default');

  /** Disabled items remain in the DOM but are not focusable / clickable. */
  public readonly disabled = input(false, { transform: booleanAttribute });

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      const host = this.el.nativeElement;
      if (this.consumerClasses === null) {
        this.consumerClasses = host.getAttribute('class') ?? '';
      }
      const base =
        'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors disabled:pointer-events-none disabled:opacity-50';
      const variantCls =
        this.variant() === 'destructive'
          ? 'text-danger-700 focus:bg-danger-50 focus:text-danger-800 hover:bg-danger-50 hover:text-danger-800'
          : 'text-brand-900 focus:bg-brand-100 hover:bg-brand-100';
      host.setAttribute('class', twMerge(base, variantCls, this.consumerClasses));
      if (this.disabled()) host.setAttribute('disabled', '');
      else host.removeAttribute('disabled');
    });
  }
}
