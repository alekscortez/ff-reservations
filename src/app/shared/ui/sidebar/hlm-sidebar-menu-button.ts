import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Menu link / button styling for sidebar nav rows. Apply to `<a>` or
 * `<button>`:
 *
 *   <a hlmSidebarMenuButton routerLink="/staff/dashboard">
 *     <ng-icon name="lucideLayoutDashboard" />
 *     <span>Dashboard</span>
 *   </a>
 *
 * Provide the `routerLinkActive` directive on the same element with
 * the active class — we apply `data-[active=true]:bg-sidebar-accent` via
 * the cva. Or call `[active]="..."` if you don't have a router context.
 */
export const sidebarMenuButtonVariants = cva(
  // Base: full-width row with icon + label, hover + focus + disabled states.
  // `[&>ng-icon]` selectors keep the icon a consistent size regardless of
  // the lucide glyph's intrinsic dimensions.
  'peer/menu-button group/menu-button relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 [&>ng-icon]:size-4 [&>ng-icon]:shrink-0 [&>span:last-child]:truncate',
  {
    variants: {
      variant: {
        default:
          'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
        outline:
          'border border-sidebar-border bg-background text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]/sidebar-wrapper:p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type SidebarMenuButtonVariants = VariantProps<typeof sidebarMenuButtonVariants>;

@Directive({
  selector: 'a[hlmSidebarMenuButton], button[hlmSidebarMenuButton]',
  exportAs: 'hlmSidebarMenuButton',
  standalone: true,
  host: {
    'data-slot': 'sidebar-menu-button',
    '[attr.data-active]': 'active() || null',
  },
})
export class HlmSidebarMenuButton {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly variant = input<SidebarMenuButtonVariants['variant']>('default');
  readonly size = input<SidebarMenuButtonVariants['size']>('default');
  readonly active = input<boolean>(false);

  private consumerClasses: string | null = null;

  constructor() {
    effect(() => {
      if (this.consumerClasses === null) {
        this.consumerClasses = this.el.nativeElement.getAttribute('class') ?? '';
      }
      const variantClasses = sidebarMenuButtonVariants({
        variant: this.variant(),
        size: this.size(),
      });
      this.el.nativeElement.setAttribute(
        'class',
        twMerge(variantClasses, this.consumerClasses),
      );
    });
  }
}
