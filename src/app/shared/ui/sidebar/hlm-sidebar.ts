import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { HlmDialog } from '../dialog';
import { HlmSidebarService } from './hlm-sidebar.service';

/**
 * Sidebar surface. On desktop it renders as a fixed-position column on
 * the left, anchored below the sticky header (via the `--header-height`
 * CSS variable read off the wrapper). On mobile it portals into
 * HlmDialog (size="sheet") so the same template slides over the content
 * from the left.
 *
 * Slots:
 *
 *   <hlm-sidebar>
 *     <hlm-sidebar-header>...</hlm-sidebar-header>
 *     <hlm-sidebar-content>...</hlm-sidebar-content>
 *     <hlm-sidebar-footer>...</hlm-sidebar-footer>
 *   </hlm-sidebar>
 *
 * Width is fixed at `w-64` (16rem) on desktop. The main content (via
 * HlmSidebarInset) reserves the same width with `md:pl-64`. When the
 * sidebar is collapsed, both the sidebar and the inset's left padding
 * collapse to 0 — handled by `group-data-[state=collapsed]/sidebar-wrapper:`
 * variants on this component and HlmSidebarInset respectively.
 */
@Component({
  selector: 'hlm-sidebar',
  standalone: true,
  imports: [CommonModule, HlmDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-state]': 'service.state()',
    '[attr.data-mobile]': 'service.isMobile()',
    class: 'contents',
  },
  template: `
    @if (service.isMobile()) {
      @if (service.openMobile()) {
        <hlm-dialog
          size="sheet"
          panelClass="left-0 right-auto top-0 bottom-0 h-svh w-64 max-w-none rounded-none rounded-r-2xl sm:w-64 bg-sidebar text-sidebar-foreground p-0"
          (close)="service.setOpenMobile(false)"
        >
          <div class="flex h-full w-full flex-col">
            <ng-content></ng-content>
          </div>
        </hlm-dialog>
      }
    } @else {
      <aside
        data-slot="sidebar-container"
        class="fixed left-0 z-40 hidden w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 ease-linear md:flex group-data-[state=collapsed]/sidebar-wrapper:-translate-x-full"
        [style.top]="'var(--header-height, 0px)'"
        [style.height]="'calc(100svh - var(--header-height, 0px))'"
      >
        <div class="flex h-full w-full flex-col">
          <ng-content></ng-content>
        </div>
      </aside>
    }
  `,
})
export class HlmSidebar {
  protected readonly service = inject(HlmSidebarService);
}
