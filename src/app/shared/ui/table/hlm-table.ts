import { Directive, ElementRef, effect, inject } from '@angular/core';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style table primitive family. Pure CSS class application —
 * the directives don't add structure, just visual styling matching
 * the existing hand-rolled `<table>` markup in this codebase.
 *
 * Pair with `@tanstack/angular-table`'s `FlexRenderDirective` for
 * sortable / filterable / paginated tables (see admin Clients page
 * for the reference example). For static tables, just use the
 * directives on plain `<table>` / `<thead>` / `<tbody>` markup.
 *
 * Each directive captures the consumer's `class` attribute on first
 * render and merges variant defaults via tailwind-merge, same as
 * `HlmButton` / `HlmBadge`. Conflicting Tailwind utilities (e.g.
 * `text-sm` vs `text-base`) resolve with the consumer's class winning.
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

/** Wrap a <table hlmTable> in this to get a horizontally scrollable container. */
@Directive({
  selector: 'div[hlmTableContainer]',
  exportAs: 'hlmTableContainer',
  standalone: true,
  host: { 'data-slot': 'table-container' },
})
export class HlmTableContainer {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(makeMergeEffect(el, 'w-full overflow-x-auto'));
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
    effect(makeMergeEffect(el, 'w-full border-collapse text-left text-sm text-brand-900'));
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
    effect(
      makeMergeEffect(
        el,
        'border-b border-brand-100 text-xs uppercase tracking-[0.18em] text-brand-500',
      ),
    );
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
    effect(makeMergeEffect(el, ''));
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
      makeMergeEffect(el, 'border-t border-brand-100 bg-brand-50/40 font-medium'),
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
    effect(
      makeMergeEffect(
        el,
        'border-b border-brand-100 transition-colors last:border-0 hover:bg-brand-50/40',
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
    effect(
      makeMergeEffect(
        el,
        'h-10 py-3 pr-3 align-middle font-semibold text-brand-500 [&:has([role=checkbox])]:pr-0',
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
      makeMergeEffect(el, 'py-3 pr-3 align-middle [&:has([role=checkbox])]:pr-0'),
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
