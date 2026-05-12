import { CommonModule } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

import { HlmSidebarService } from './hlm-sidebar.service';

/**
 * Sidebar surface. On desktop renders as TWO divs (Spartan's gap +
 * container pattern):
 *
 *   1. A "gap" div with real layout width — this is what reserves
 *      space in the flex row. Animating its width from w-64 to w-0
 *      naturally causes the adjacent `<main hlmSidebarInset>` to
 *      flex-grow into the freed space. No padding-left hack on the
 *      inset, no display:contents Safari bug — just standard flex
 *      sizing.
 *
 *   2. A fixed-positioned "container" div that holds the visual
 *      sidebar UI. Anchored to top:--header-height so it sits below
 *      a sticky header; slides off (translate-x) when collapsed.
 *
 * On mobile the same content portals into HlmDialog (size="sheet") so
 * the slide-over doesn't take layout space.
 *
 * Slots:
 *
 *   <hlm-sidebar>
 *     <hlm-sidebar-header>...</hlm-sidebar-header>
 *     <hlm-sidebar-content>...</hlm-sidebar-content>
 *     <hlm-sidebar-footer>...</hlm-sidebar-footer>
 *   </hlm-sidebar>
 *
 * Pair with `<main hlmSidebarInset>` as a flex sibling in the row.
 */
@Component({
  selector: 'hlm-sidebar',
  standalone: true,
  imports: [CommonModule, A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-state]': 'service.state()',
    '[attr.data-mobile]': 'service.isMobile()',
    class: 'contents',
  },
  template: `
    <ng-template #contents>
      <ng-content></ng-content>
    </ng-template>

    @if (service.isMobile()) {
      @if (service.openMobile()) {
        <!-- Backdrop: dismisses on click -->
        <div
          class="fixed inset-0 z-[290] bg-black/50"
          (click)="service.setOpenMobile(false)"
          aria-hidden="true"
        ></div>
        <!-- Slide-over sheet from left. Plain fixed positioning so we
             land at left:0 regardless of any parent's flex alignment. -->
        <aside
          data-slot="sidebar-mobile"
          class="fixed inset-y-0 left-0 z-[300] flex h-svh w-64 flex-col rounded-r-2xl bg-sidebar text-sidebar-foreground shadow-2xl"
          cdkTrapFocus
          cdkTrapFocusAutoCapture
          role="dialog"
          aria-modal="true"
          (keydown.escape)="service.setOpenMobile(false)"
        >
          <ng-container *ngTemplateOutlet="contents"></ng-container>
        </aside>
      }
    } @else {
      <!-- Gap: real layout-occupying div in the flex row. Animating its
           width drives the inset's flex-grow reflow automatically. -->
      <div
        data-slot="sidebar-gap"
        class="relative hidden w-64 bg-transparent transition-[width] duration-200 ease-linear group-data-[state=collapsed]/sidebar-wrapper:w-0 md:block"
        aria-hidden="true"
      ></div>

      <!-- Container: visual sidebar, fixed-positioned, slides off when
           collapsed via left-[-16rem]. -->
      <aside
        data-slot="sidebar-container"
        class="fixed left-0 z-40 hidden w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[left] duration-200 ease-linear md:flex group-data-[state=collapsed]/sidebar-wrapper:left-[-16rem]"
        [style.top]="'var(--header-height, 0px)'"
        [style.height]="'calc(100svh - var(--header-height, 0px))'"
      >
        <div class="flex h-full w-full flex-col">
          <ng-container *ngTemplateOutlet="contents"></ng-container>
        </div>
      </aside>
    }
  `,
})
export class HlmSidebar {
  protected readonly service = inject(HlmSidebarService);
  private readonly doc = inject(DOCUMENT);

  constructor() {
    // Lock body scroll while the mobile sheet is open; restore on close.
    let previousOverflow: string | null = null;
    effect(() => {
      const lock = this.service.isMobile() && this.service.openMobile();
      if (lock) {
        if (previousOverflow === null) {
          previousOverflow = this.doc.body.style.overflow;
        }
        this.doc.body.style.overflow = 'hidden';
      } else if (previousOverflow !== null) {
        this.doc.body.style.overflow = previousOverflow;
        previousOverflow = null;
      }
    });
  }
}
