import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmNumberedPagination, createPageArray, outOfBoundCorrection } from './hlm-numbered-pagination';

describe('createPageArray (sliding window)', () => {
  it('returns 1 page when there are no items', () => {
    expect(createPageArray(1, 50, 0, 7)).toEqual([1]);
  });

  it('returns all pages when total fits in the range', () => {
    expect(createPageArray(1, 10, 30, 7)).toEqual([1, 2, 3]);
  });

  it('shows leading ellipsis when current page is near the end', () => {
    const pages = createPageArray(28, 50, 1400, 7);
    expect(pages[0]).toBe(1);
    expect(pages).toContain('...');
    expect(pages[pages.length - 1]).toBe(28);
  });

  it('shows trailing ellipsis when current page is near the start', () => {
    const pages = createPageArray(1, 50, 1400, 7);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(28);
    expect(pages).toContain('...');
  });

  it('shows ellipses on both sides when current page is in the middle', () => {
    const pages = createPageArray(14, 50, 1400, 7);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(28);
    const ellipses = pages.filter((p) => p === '...');
    expect(ellipses.length).toBe(2);
  });
});

describe('outOfBoundCorrection', () => {
  it('clamps below 1', () => {
    expect(outOfBoundCorrection(100, 10, 0)).toBe(1);
    expect(outOfBoundCorrection(100, 10, -5)).toBe(1);
  });

  it('clamps above last page', () => {
    expect(outOfBoundCorrection(100, 10, 20)).toBe(10);
  });

  it('passes through valid current page', () => {
    expect(outOfBoundCorrection(100, 10, 5)).toBe(5);
  });
});

@Component({
  standalone: true,
  imports: [HlmNumberedPagination],
  template: `
    <hlm-numbered-pagination
      [(currentPage)]="current"
      [(itemsPerPage)]="size"
      [totalItems]="total()"
    />
  `,
})
class Host {
  current = signal(1);
  size = signal(50);
  total = signal(1400);
}

function createHost(initial?: Partial<{ current: number; size: number; total: number }>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial?.current !== undefined) fixture.componentInstance.current.set(initial.current);
  if (initial?.size !== undefined) fixture.componentInstance.size.set(initial.size);
  if (initial?.total !== undefined) fixture.componentInstance.total.set(initial.total);
  fixture.detectChanges();
  return fixture;
}

describe('HlmNumberedPagination', () => {
  it('renders Previous + page numbers + Next', () => {
    const fixture = createHost({ current: 5, size: 50, total: 1400 });
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Previous');
    expect(html).toContain('Next');
  });

  it('hides Previous on first page', () => {
    const fixture = createHost({ current: 1 });
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Previous');
  });

  it('hides Next on last page', () => {
    const fixture = createHost({ current: 28, size: 50, total: 1400 });
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Next');
  });

  it('clamping: setting currentPage past the end snaps back to last page', () => {
    const fixture = createHost({ current: 99, size: 50, total: 1400 });
    expect(fixture.componentInstance.current()).toBe(28);
  });

  it('clicking a page button updates the bound signal', () => {
    const fixture = createHost({ current: 1, size: 50, total: 1400 });
    const buttons = fixture.nativeElement.querySelectorAll('button[hlmPaginationLink]');
    // page buttons are after the (hidden-on-first-page) prev slot — find one labelled "2"
    const page2 = Array.from(buttons as NodeListOf<HTMLButtonElement>).find(
      (b) => b.textContent?.trim() === '2',
    );
    expect(page2).toBeTruthy();
    page2!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.current()).toBe(2);
  });
});
