import { Directive } from '@angular/core';

/**
 * Apply to each <li> inside [hlmPaginationContent]. Pure semantic
 * marker — no styles. The inner button / ellipsis handles its own
 * visuals.
 */
@Directive({
  selector: 'li[hlmPaginationItem]',
  exportAs: 'hlmPaginationItem',
  standalone: true,
  host: {
    'data-slot': 'pagination-item',
  },
})
export class HlmPaginationItem {}
