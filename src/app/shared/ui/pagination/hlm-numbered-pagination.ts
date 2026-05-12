import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  model,
  numberAttribute,
  untracked,
} from '@angular/core';

import { HlmPagination } from './hlm-pagination';
import { HlmPaginationContent } from './hlm-pagination-content';
import { HlmPaginationEllipsis } from './hlm-pagination-ellipsis';
import { HlmPaginationItem } from './hlm-pagination-item';
import { HlmPaginationLink } from './hlm-pagination-link';
import { HlmPaginationNext } from './hlm-pagination-next';
import { HlmPaginationPrevious } from './hlm-pagination-previous';

/**
 * High-level numbered-pagination wrapper. Renders previous / page
 * numbers (with ellipses) / next inside a `<nav hlmPagination>`.
 *
 * @example
 *   <hlm-numbered-pagination
 *     [(currentPage)]="currentPage"
 *     [itemsPerPage]="pageSize()"
 *     [totalItems]="filtered().length" />
 *
 * `currentPage` and `itemsPerPage` are `model()` signals so callers
 * can two-way-bind their own signals.
 *
 * Page-window logic (sliding window of N pages around current, with
 * ellipses on either side) is adapted from `ngx-pagination` / Spartan
 * — kept here so the primitive family is self-contained.
 */
@Component({
  selector: 'hlm-numbered-pagination',
  standalone: true,
  imports: [
    HlmPagination,
    HlmPaginationContent,
    HlmPaginationItem,
    HlmPaginationLink,
    HlmPaginationPrevious,
    HlmPaginationNext,
    HlmPaginationEllipsis,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav hlmPagination [attr.aria-label]="ariaLabel()">
      <ul hlmPaginationContent>
        @if (showEdges() && !_isFirstPageActive()) {
          <li hlmPaginationItem (click)="_goToPrevious()">
            <hlm-pagination-previous [iconOnly]="iconOnlyEdges()" />
          </li>
        }

        @for (page of _pages(); track $index) {
          <li hlmPaginationItem>
            @if (page === '...') {
              <hlm-pagination-ellipsis />
            } @else {
              <button
                hlmPaginationLink
                type="button"
                [isActive]="currentPage() === page"
                [attr.aria-label]="'Go to page ' + page"
                (click)="_setPage(page)"
              >
                {{ page }}
              </button>
            }
          </li>
        }

        @if (showEdges() && !_isLastPageActive()) {
          <li hlmPaginationItem (click)="_goToNext()">
            <hlm-pagination-next [iconOnly]="iconOnlyEdges()" />
          </li>
        }
      </ul>
    </nav>
  `,
})
export class HlmNumberedPagination {
  public readonly currentPage = model.required<number>();
  public readonly itemsPerPage = model.required<number>();

  public readonly totalItems = input.required<number, number | string>({
    transform: numberAttribute,
  });

  public readonly maxSize = input<number, number | string>(7, {
    transform: numberAttribute,
  });

  public readonly showEdges = input<boolean, boolean | string>(true, {
    transform: booleanAttribute,
  });

  public readonly iconOnlyEdges = input<boolean, boolean | string>(false, {
    transform: booleanAttribute,
  });

  public readonly ariaLabel = input<string>('Pagination');

  protected readonly _lastPageNumber = computed(() => {
    const total = this.totalItems();
    const size = this.itemsPerPage();
    if (total < 1 || size < 1) return 1;
    return Math.ceil(total / size);
  });

  protected readonly _isFirstPageActive = computed(() => this.currentPage() <= 1);
  protected readonly _isLastPageActive = computed(
    () => this.currentPage() >= this._lastPageNumber(),
  );

  protected readonly _pages = computed(() => {
    const corrected = outOfBoundCorrection(
      this.totalItems(),
      this.itemsPerPage(),
      this.currentPage(),
    );
    if (corrected !== this.currentPage()) {
      untracked(() => this.currentPage.set(corrected));
    }
    return createPageArray(
      corrected,
      this.itemsPerPage(),
      this.totalItems(),
      this.maxSize(),
    );
  });

  protected _goToPrevious(): void {
    this.currentPage.set(Math.max(1, this.currentPage() - 1));
  }

  protected _goToNext(): void {
    this.currentPage.set(Math.min(this._lastPageNumber(), this.currentPage() + 1));
  }

  protected _setPage(page: number): void {
    this.currentPage.set(page);
  }
}

export type Page = number | '...';

export function outOfBoundCorrection(
  totalItems: number,
  itemsPerPage: number,
  currentPage: number,
): number {
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages < currentPage && totalPages > 0) return totalPages;
  if (currentPage < 1) return 1;
  return currentPage;
}

export function createPageArray(
  currentPage: number,
  itemsPerPage: number,
  totalItems: number,
  paginationRange: number,
): Page[] {
  paginationRange = +paginationRange;
  const pages: Page[] = [];
  const totalPages = Math.max(Math.ceil(totalItems / itemsPerPage), 1);
  const halfWay = Math.ceil(paginationRange / 2);

  const isStart = currentPage <= halfWay;
  const isEnd = totalPages - halfWay < currentPage;
  const isMiddle = !isStart && !isEnd;
  const ellipsesNeeded = paginationRange < totalPages;

  let i = 1;
  while (i <= totalPages && i <= paginationRange) {
    let label: number | '...';
    const pageNumber = calculatePageNumber(i, currentPage, paginationRange, totalPages);
    const openingEllipsesNeeded = i === 2 && (isMiddle || isEnd);
    const closingEllipsesNeeded = i === paginationRange - 1 && (isMiddle || isStart);
    if (ellipsesNeeded && (openingEllipsesNeeded || closingEllipsesNeeded)) {
      label = '...';
    } else {
      label = pageNumber;
    }
    pages.push(label);
    i++;
  }
  return pages;
}

function calculatePageNumber(
  i: number,
  currentPage: number,
  paginationRange: number,
  totalPages: number,
): number {
  const halfWay = Math.ceil(paginationRange / 2);
  if (i === paginationRange) return totalPages;
  if (i === 1) return i;
  if (paginationRange < totalPages) {
    if (totalPages - halfWay < currentPage) return totalPages - paginationRange + i;
    if (halfWay < currentPage) return currentPage - halfWay + i;
    return i;
  }
  return i;
}
