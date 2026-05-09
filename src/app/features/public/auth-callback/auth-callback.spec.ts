import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AuthCallback } from './auth-callback';
import { provideMockOidc } from '../../../testing/oidc-mock';

describe('AuthCallback', () => {
  let component: AuthCallback;
  let fixture: ComponentFixture<AuthCallback>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AuthCallback],
      providers: [
        provideRouter([
          { path: 'unauthorized', children: [] },
          { path: 'staff/dashboard', children: [] },
        ]),
        provideMockOidc(),
      ],
    })
    .compileComponents();

    fixture = TestBed.createComponent(AuthCallback);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
