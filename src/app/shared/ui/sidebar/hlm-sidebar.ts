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
 *      causes the adjacent `<main hlmSidebarInset>` (which is
 *      `flex-1`) to flex-grow into the freed space AUTOMATICALLY, on
 *      every animation frame, because flex layout recomputes child
 *      sizes when any sibling's width changes. No padding-left hack
 *      on the inset, no display:contents Safari bug — just standard
 *      flex sizing. The visual sidebar is a separate fixed-positioned
 *      `<aside>` that slides off (left: 0 → -16rem) in lockstep over
 *      the same 200ms.
 *
 *   2. A fixed-positioned "container" div that holds the visual
 *      sidebar UI. Anchored to top:--header-height so it sits below
 *      a sticky header; slides off (translate-x) when collapsed.
 *
 * On mobile, the desktop branch is skipped and the same content
 * renders inside a fixed-positioned `<aside class="fixed inset-y-0
 * left-0 z-[300] ...">` plus a sibling backdrop, with body-scroll
 * lock + cdkTrapFocus implemented inline. We do NOT route through
 * HlmDialog for mobile: HlmDialog's `sheet` variant uses
 * `flex items-end justify-center` which conflicts with `left:0`
 * positioning. See memory `sidebar_shell_spartan_pattern.md` for
 * the full rationale (including the mobile slide animation's
 * inline-style transitions and Tailwind dev-server scanner
 * sidestepping).
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
 * `<hlm-sidebar>` uses `display: block` (not `contents`) to avoid
 * Safari reflow bugs — see memory `safari_display_contents_flex_bug.md`.
 */
@Component({
  selector: 'hlm-sidebar',
  standalone: true,
  imports: [CommonModule, A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-state]': 'service.state()',
    '[attr.data-mobile]': 'service.isMobile()',
    // `block` — not `contents` — because `display: contents` has long-
    // standing Safari bugs where descendants don't pick up flex sizing
    // from the grandparent (see memory:
    // safari_display_contents_flex_bug.md). The chain
    // <app-shell flex> > <app-sidebar flex> > <hlm-sidebar block> >
    // gap div + fixed aside keeps every layer as a real layout-tree
    // participant.
    class: 'block',
  },
  template: `
    <ng-template #contents>
      <ng-content></ng-content>
    </ng-template>

    @if (service.isMobile()) {
      <!-- Backdrop: always rendered, opacity-toggled so the fade
           animates in both directions. Inline styles (not Tailwind
           classes) for opacity / transition because the dev-server
           Tailwind content scanner can miss newly-added utilities
           until restart; inline bindings work regardless of scanner
           state. -->
      <div
        class="fixed inset-0 z-[290] bg-black/50"
        [style.opacity]="service.openMobile() ? 1 : 0"
        [style.pointer-events]="service.openMobile() ? 'auto' : 'none'"
        [style.transition]="'opacity 200ms ease-out'"
        (click)="service.setOpenMobile(false)"
        aria-hidden="true"
      ></div>
      <!-- Slide-over sheet from left. Always rendered; slides on/off
           via inline transform. Explicit translateX(0) for the open
           state (not removing the inline style) because going to or
           from transform:none has known browser interpolation quirks
           — interpolating between two explicit matrix values is
           reliable. The inert attribute keeps it out of focus and
           interaction order while hidden; cdkTrapFocus activates
           only when open. -->
      <aside
        data-slot="sidebar-mobile"
        class="fixed inset-y-0 left-0 z-[300] flex h-svh w-64 flex-col rounded-r-2xl bg-sidebar text-sidebar-foreground shadow-2xl"
        [style.transform]="service.openMobile() ? 'translateX(0)' : 'translateX(-100%)'"
        [style.transition]="'transform 200ms ease-out'"
        [attr.aria-hidden]="!service.openMobile() ? 'true' : null"
        [attr.inert]="!service.openMobile() ? '' : null"
        [cdkTrapFocus]="service.openMobile()"
        [cdkTrapFocusAutoCapture]="service.openMobile()"
        role="dialog"
        aria-modal="true"
        (keydown.escape)="service.setOpenMobile(false)"
      >
        <ng-container *ngTemplateOutlet="contents"></ng-container>
      </aside>
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
