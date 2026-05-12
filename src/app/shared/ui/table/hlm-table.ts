import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style table primitive family. Pure CSS class application —
 * the directives don't add structure, just visual styling matching
 * the existing hand-rolled `<table>` markup in this codebase.
 *
 * Pair with `@tanstack/angular-table`'s `createAngularTable` for
 * sortable / filterable / paginated tables. **Declarative cells
 * (`<td>{{ row.x }}</td>`) — NOT `FlexRenderDirective`.** The
 * declarative form composes cleanly with the inline edit-row
 * pattern and keeps templates readable; `flexRender` only earns its
 * complexity when you need runtime-defined cell renderers, none of
 * which we currently have. The admin Clients page
 * (`features/admin/clients/`) is the reference example.
 *
 * For static tables (no sort / filter / pagination), just use the
 * directives on plain `<table>` / `<thead>` / `<tbody>` markup
 * without TanStack.
 *
 * Each directive captures the consumer's `class` attribute on first
 * render and merges variant defaults via tailwind-merge, same as
 * `HlmButton` / `HlmBadge`. Conflicting Tailwind utilities (e.g.
 * `text-sm` vs `text-base`) resolve with the consumer's class
 * winning.
 *
 * See memory `data_tables_spartan_pattern.md` for the 6 patterns
 * that matter (TanStack proxy as Signal, OnPush gotcha with
 * `column.getIsSorted()`, pagination integration, search-reset
 * effect, Spartan-stock card layout, columns-visibility recipe).
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

/**
 * Inner scroll container for `<table hlmTable>`. Pure horizontal-scroll
 * behavior so wide tables don't overflow their parent on small viewports.
 *
 * For the Spartan-stock "card" look, wrap this in an outer
 * `<div class="overflow-hidden rounded-md border border-brand-200">`
 * — the outer's `overflow-hidden` clips the row dividers against the
 * rounded corners. Splitting the two wrappers is necessary because
 * `overflow-x-auto` would force a vertical scrollbar if combined with
 * the rounded clip on a single element.
 */
@Directive({
  selector: 'div[hlmTableContainer]',
  exportAs: 'hlmTableContainer',
  standalone: true,
  host: { 'data-slot': 'table-container' },
})
export class HlmTableContainer {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(makeMergeEffect(el, 'relative w-full overflow-x-auto'));
  }
}

@Directive({
  selector: 'table[hlmTable]',
  exportAs: 'hlmTable',
  standalone: true,
  host: { 'data-slot': 'table' },
})
export class HlmTable {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(makeMergeEffect(el, 'w-full caption-bottom border-collapse text-sm text-brand-900'));
  }
}

@Directive({
  selector: 'thead[hlmTHead]',
  exportAs: 'hlmTHead',
  standalone: true,
  host: { 'data-slot': 'table-header' },
})
export class HlmTHead {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // No bottom border on thead itself — the last header row's hlmTr
    // carries the divider so tbody and thead share the same line.
    effect(makeMergeEffect(el, ''));
  }
}

@Directive({
  selector: 'tbody[hlmTBody]',
  exportAs: 'hlmTBody',
  standalone: true,
  host: { 'data-slot': 'table-body' },
})
export class HlmTBody {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(makeMergeEffect(el, '[&_tr:last-child]:border-0'));
  }
}

@Directive({
  selector: 'tfoot[hlmTFoot]',
  exportAs: 'hlmTFoot',
  standalone: true,
  host: { 'data-slot': 'table-footer' },
})
export class HlmTFoot {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(
      makeMergeEffect(el, 'border-t border-brand-200 bg-brand-50/40 font-medium'),
    );
  }
}

@Directive({
  selector: 'tr[hlmTr]',
  exportAs: 'hlmTr',
  standalone: true,
  host: { 'data-slot': 'table-row' },
})
export class HlmTr {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // Mirrors Spartan's spartan-table-row: subtle hover tint that's
    // visible without competing for attention. `bg-brand-100/50` ≈
    // `bg-muted/50` in shadcn's default light theme.
    effect(
      makeMergeEffect(
        el,
        'border-b border-brand-100 transition-colors hover:bg-brand-100/50 data-[state=selected]:bg-brand-100',
      ),
    );
  }
}

@Directive({
  selector: 'th[hlmTh]',
  exportAs: 'hlmTh',
  standalone: true,
  host: { 'data-slot': 'table-head' },
})
export class HlmTh {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // Spartan-stock: 12 px tall, left-aligned, regular body-color text
    // with reduced contrast. No uppercase tracking — sort header /
    // visual hierarchy carries weight.
    effect(
      makeMergeEffect(
        el,
        'h-12 px-4 text-left align-middle font-medium text-brand-500 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
      ),
    );
  }
}

@Directive({
  selector: 'td[hlmTd]',
  exportAs: 'hlmTd',
  standalone: true,
  host: { 'data-slot': 'table-cell' },
})
export class HlmTd {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(
      makeMergeEffect(el, 'p-4 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]'),
    );
  }
}

@Directive({
  selector: 'caption[hlmCaption]',
  exportAs: 'hlmCaption',
  standalone: true,
  host: { 'data-slot': 'table-caption' },
})
export class HlmCaption {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(makeMergeEffect(el, 'mt-4 text-sm text-brand-500'));
  }
}
