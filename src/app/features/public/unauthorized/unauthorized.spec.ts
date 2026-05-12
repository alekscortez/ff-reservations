import { ComponentFixture, TestBed } from '@angular/core/testing';

import { provideMockOidc } from '../../../testing/oidc-mock';
import { Unauthorized } from './unauthorized';

describe('Unauthorized', () => {
  let component: Unauthorized;
  let fixture: ComponentFixture<Unauthorized>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Unauthorized],
      providers: [provideMockOidc()],
    }).compileComponents();

    fixture = TestBed.createComponent(Unauthorized);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
