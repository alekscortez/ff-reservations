import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TableMap } from './table-map';

describe('TableMap', () => {
  let component: TableMap;
  let fixture: ComponentFixture<TableMap>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TableMap]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TableMap);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
