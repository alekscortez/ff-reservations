import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { CheckIn } from './check-in';

describe('CheckIn', () => {
  let component: CheckIn;
  let fixture: ComponentFixture<CheckIn>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CheckIn],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
    .compileComponents();

    fixture = TestBed.createComponent(CheckIn);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
