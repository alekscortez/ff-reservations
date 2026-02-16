import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TableMap } from './table-map';

describe('TableMap', () => {
  it('should create', () => {
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
});
