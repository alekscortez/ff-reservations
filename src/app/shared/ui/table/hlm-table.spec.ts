import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createAngularTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
} from '@tanstack/angular-table';

import {
  HlmTable,
  HlmTBody,
  HlmTHead,
  HlmTd,
  HlmTh,
  HlmTr,
  HlmTableContainer,
} from './hlm-table';
import { HlmTableSortHeader } from './hlm-table-sort-header';

describe('HlmTable directive family', () => {
  @Component({
    standalone: true,
    imports: [HlmTable, HlmTBody, HlmTHead, HlmTd, HlmTh, HlmTr, HlmTableContainer],
    template: `
      <div hlmTableContainer>
        <table hlmTable>
          <thead hlmTHead>
            <tr hlmTr>
              <th hlmTh>Name</th>
            </tr>
          </thead>
          <tbody hlmTBody>
            <tr hlmTr>
              <td hlmTd>Alice</td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
  })
  class Host {}

  it('applies the variant defaults to each element', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('div[hlmTableContainer]')!.className).toContain('overflow-x-auto');
    expect(root.querySelector('table[hlmTable]')!.className).toContain('border-collapse');
    expect(root.querySelector('table[hlmTable]')!.className).toContain('caption-bottom');
    // Spartan-stock: th is left-aligned, normal weight, muted color, h-12 — no uppercase tracking.
    expect(root.querySelector('th[hlmTh]')!.className).toContain('h-12');
    expect(root.querySelector('th[hlmTh]')!.className).toContain('font-medium');
    expect(root.querySelector('th[hlmTh]')!.className).not.toContain('uppercase');
    expect(root.querySelector('td[hlmTd]')!.className).toContain('p-4');
    expect(root.querySelector('tr[hlmTr]')!.className).toContain('hover:bg-brand-100/50');
    expect(root.querySelector('tr[hlmTr]')!.className).toContain('transition-colors');
  });

  it('preserves consumer-provided classes (tailwind-merge)', () => {
    @Component({
      standalone: true,
      imports: [HlmTable],
      template: `<table hlmTable class="text-base text-blue-500"></table>`,
    })
    class CustomHost {}
    TestBed.configureTestingModule({ imports: [CustomHost] });
    const fixture = TestBed.createComponent(CustomHost);
    fixture.detectChanges();
    const cls = (fixture.nativeElement as HTMLElement).querySelector('table')!.className;
    // consumer wins for conflicting utilities (text-sm in variant vs text-base from consumer)
    expect(cls).toContain('text-base');
    expect(cls).not.toContain('text-sm');
    // non-conflicting variant defaults still apply
    expect(cls).toContain('border-collapse');
  });
});

type Row = { id: string; name: string; spend: number };

const rows: Row[] = [
  { id: 'a', name: 'Beta', spend: 100 },
  { id: 'b', name: 'Alpha', spend: 300 },
  { id: 'c', name: 'Gamma', spend: 200 },
];

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', id: 'name' },
  { accessorKey: 'spend', id: 'spend' },
];

describe('HlmTableSortHeader', () => {
  @Component({
    standalone: true,
    imports: [HlmTableSortHeader],
    template: `
      <hlm-table-sort-header [column]="table.getColumn('name')!" label="Name" />
    `,
  })
  class Host {
    sorting = signal<{ id: string; desc: boolean }[]>([]);
    table = createAngularTable<Row>(() => ({
      data: rows,
      columns,
      state: { sorting: this.sorting() },
      onSortingChange: (updater) => {
        const next = typeof updater === 'function' ? updater(this.sorting()) : updater;
        this.sorting.set(next);
      },
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
    }));
  }

  function createHost() {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  it('cycles unsorted → asc → desc → unsorted on click', () => {
    const fixture = createHost();
    const btn = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    // initial: unsorted
    expect(fixture.componentInstance.sorting()).toEqual([]);

    btn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.sorting()).toEqual([{ id: 'name', desc: false }]);

    btn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.sorting()).toEqual([{ id: 'name', desc: true }]);

    btn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.sorting()).toEqual([]);
  });

  it('exposes aria-label describing the next action', () => {
    const fixture = createHost();
    const btn = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toBe('Sort Name ascending');
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-label')).toBe('Sort Name descending');
  });

  it('reflects sorted state on data-sorted attr', () => {
    const fixture = createHost();
    const btn = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(btn.getAttribute('data-sorted')).toBeNull();
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('data-sorted')).toBe('');
  });
});
