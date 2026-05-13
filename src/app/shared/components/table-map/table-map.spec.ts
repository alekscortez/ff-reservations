import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TableMap } from './table-map';
import { TableForEvent } from '../../models/table.model';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="A01"><ellipse cx="10" cy="10" rx="5" ry="5"/></g>
  <g id="A02"><ellipse cx="30" cy="10" rx="5" ry="5"/></g>
  <g id="A03"><ellipse cx="50" cy="10" rx="5" ry="5"/></g>
</svg>`;

function makeTable(id: string, overrides: Partial<TableForEvent> = {}): TableForEvent {
  const num = Number(id.slice(1));
  return {
    id,
    number: num,
    section: id[0],
    price: 200,
    status: 'AVAILABLE',
    disabled: false,
    ...overrides,
  };
}

async function setup(opts: {
  tables: TableForEvent[];
  selectedTableId?: string | null;
  interactive?: boolean;
  svg?: string;
}): Promise<ComponentFixture<TableMap>> {
  TestBed.configureTestingModule({
    imports: [TableMap],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(TableMap);
  fixture.componentInstance.tables = opts.tables;
  if (opts.selectedTableId !== undefined) {
    fixture.componentInstance.selectedTableId = opts.selectedTableId;
  }
  if (opts.interactive !== undefined) {
    fixture.componentInstance.interactive = opts.interactive;
  }
  fixture.detectChanges();

  const httpMock = TestBed.inject(HttpTestingController);
  const req = httpMock.expectOne('assets/maps/FF_Reservations_Map.normalized.svg');
  req.flush(opts.svg ?? SVG);
  httpMock.verify();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('TableMap', () => {
  it('renders an empty SVG without erroring (legacy smoke)', () => {
    TestBed.configureTestingModule({
      imports: [TableMap],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(TableMap);
    fixture.detectChanges();

    const httpMock = TestBed.inject(HttpTestingController);
    const req = httpMock.expectOne('assets/maps/FF_Reservations_Map.normalized.svg');
    req.flush('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
    httpMock.verify();

    expect(fixture.componentInstance).toBeTruthy();
  });

  it('marks AVAILABLE tables with role=button, aria-label, and roving tabindex', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
    });
    const els = Array.from(
      fixture.nativeElement.querySelectorAll('.ff-map-root [data-table-id]')
    ) as Element[];
    expect(els.length).toBe(3);
    for (const el of els) {
      expect(el.getAttribute('role')).toBe('button');
      expect(el.getAttribute('aria-label')).toMatch(
        /^Table A0[1-3], section A, \$200, available$/
      );
      expect(el.getAttribute('data-clickable')).toBe('true');
    }
    const sorted = els.map((el) => el.getAttribute('tabindex')).sort();
    expect(sorted).toEqual(['-1', '-1', '0']);
    expect(els[0].getAttribute('tabindex')).toBe('0');
  });

  it('non-AVAILABLE tables stay inert (no role/aria-label/tabindex)', async () => {
    const fixture = await setup({
      tables: [
        makeTable('A01', { status: 'RESERVED' }),
        makeTable('A02', { status: 'HOLD' }),
        makeTable('A03', { status: 'DISABLED', disabled: true }),
      ],
    });
    const els = Array.from(
      fixture.nativeElement.querySelectorAll('.ff-map-root [data-table-id]')
    ) as Element[];
    expect(els.length).toBe(3);
    for (const el of els) {
      expect(el.hasAttribute('role')).toBe(false);
      expect(el.hasAttribute('aria-label')).toBe(false);
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(el.getAttribute('data-clickable')).toBe('false');
    }
  });

  it('selected table becomes the rover and gets aria-pressed=true', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
      selectedTableId: 'A02',
    });
    const a01 = fixture.nativeElement.querySelector('[data-table-id="A01"]')!;
    const a02 = fixture.nativeElement.querySelector('[data-table-id="A02"]')!;
    const a03 = fixture.nativeElement.querySelector('[data-table-id="A03"]')!;
    expect(a02.getAttribute('tabindex')).toBe('0');
    expect(a01.getAttribute('tabindex')).toBe('-1');
    expect(a03.getAttribute('tabindex')).toBe('-1');
    expect(a02.getAttribute('aria-pressed')).toBe('true');
    expect(a01.hasAttribute('aria-pressed')).toBe(false);
    expect(a03.hasAttribute('aria-pressed')).toBe(false);
  });

  it('interactive=false strips all interactive a11y attributes and hides instructions', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
      interactive: false,
    });
    const els = Array.from(
      fixture.nativeElement.querySelectorAll('.ff-map-root [data-table-id]')
    ) as Element[];
    for (const el of els) {
      expect(el.hasAttribute('role')).toBe(false);
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(el.hasAttribute('aria-label')).toBe(false);
      expect(el.getAttribute('data-clickable')).toBe('false');
    }
    expect(fixture.nativeElement.querySelector('.ff-map-sr-only')).toBeFalsy();
  });

  it('interactive=true renders the visually-hidden keyboard hint', async () => {
    const fixture = await setup({ tables: [makeTable('A01')] });
    const hint = fixture.nativeElement.querySelector('.ff-map-sr-only') as HTMLElement | null;
    expect(hint).toBeTruthy();
    expect(hint!.textContent ?? '').toContain('arrow keys');
    expect(hint!.textContent ?? '').toContain('Enter');
  });

  it('Enter on an AVAILABLE table emits tableSelect', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
    });
    const emitted: TableForEvent[] = [];
    fixture.componentInstance.tableSelect.subscribe((t) => emitted.push(t));

    const a02 = fixture.nativeElement.querySelector('[data-table-id="A02"]') as Element;
    a02.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('A02');
  });

  it('Space on an AVAILABLE table emits tableSelect', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
    });
    const emitted: TableForEvent[] = [];
    fixture.componentInstance.tableSelect.subscribe((t) => emitted.push(t));

    const a01 = fixture.nativeElement.querySelector('[data-table-id="A01"]') as Element;
    a01.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('A01');
  });

  it('Enter on a non-AVAILABLE table is a no-op', async () => {
    const fixture = await setup({
      tables: [
        makeTable('A01', { status: 'RESERVED' }),
        makeTable('A02'),
        makeTable('A03'),
      ],
    });
    const emitted: TableForEvent[] = [];
    fixture.componentInstance.tableSelect.subscribe((t) => emitted.push(t));

    const a01 = fixture.nativeElement.querySelector('[data-table-id="A01"]') as Element;
    a01.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(emitted).toHaveLength(0);
  });

  it('Home moves the rover to the first AVAILABLE table', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
      selectedTableId: 'A03',
    });
    const a03 = fixture.nativeElement.querySelector('[data-table-id="A03"]') as Element;
    expect(a03.getAttribute('tabindex')).toBe('0');

    a03.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

    expect(
      fixture.nativeElement.querySelector('[data-table-id="A01"]')!.getAttribute('tabindex')
    ).toBe('0');
    expect(
      fixture.nativeElement.querySelector('[data-table-id="A02"]')!.getAttribute('tabindex')
    ).toBe('-1');
    expect(a03.getAttribute('tabindex')).toBe('-1');
  });

  it('End moves the rover to the last AVAILABLE table', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02'), makeTable('A03')],
    });
    const a01 = fixture.nativeElement.querySelector('[data-table-id="A01"]') as Element;
    expect(a01.getAttribute('tabindex')).toBe('0');

    a01.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));

    expect(a01.getAttribute('tabindex')).toBe('-1');
    expect(
      fixture.nativeElement.querySelector('[data-table-id="A03"]')!.getAttribute('tabindex')
    ).toBe('0');
  });

  it('Enter while interactive=false does not emit', async () => {
    const fixture = await setup({
      tables: [makeTable('A01'), makeTable('A02')],
      interactive: false,
    });
    const emitted: TableForEvent[] = [];
    fixture.componentInstance.tableSelect.subscribe((t) => emitted.push(t));

    const a01 = fixture.nativeElement.querySelector('[data-table-id="A01"]') as Element;
    a01.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(emitted).toHaveLength(0);
  });
});
