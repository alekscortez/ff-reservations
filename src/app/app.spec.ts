import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { firstValueFrom, of, take } from 'rxjs';

import { App } from './app';
import { provideMockOidc } from './testing/oidc-mock';

@Component({ standalone: true, template: '' })
class BlankPage {}

function provideAuthedOidc() {
  const stub = {
    isAuthenticated$: of({ isAuthenticated: true, allConfigsAuthenticated: [] }),
    userData$: of({ userData: null, allUserData: [] }),
    checkAuth: () => of({ isAuthenticated: true, userData: null }),
    getAccessToken: () => of(''),
    getIdToken: () => of(''),
    getAuthenticationResult: () => of(null),
    authorize: () => undefined,
    logoff: () => of(null),
    logoffLocal: () => undefined,
  };
  return { provide: OidcSecurityService, useValue: stub };
}

describe('App', () => {
  describe('default mock (unauthenticated)', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [App],
        providers: [provideRouter([]), provideMockOidc()],
      }).compileComponents();
    });

    it('should create the app', () => {
      const fixture = TestBed.createComponent(App);
      const app = fixture.componentInstance;
      expect(app).toBeTruthy();
    });

    it('shellMode$ resolves to "public" when not authenticated', async () => {
      const fixture = TestBed.createComponent(App);
      const mode = await firstValueFrom(
        fixture.componentInstance.shellMode$.pipe(take(1))
      );
      expect(mode).toBe('public');
    });
  });

  describe('authenticated', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [App],
        providers: [
          provideRouter([
            { path: 'staff/dashboard', component: BlankPage },
            { path: 'reserva', component: BlankPage },
            { path: 'check-in/pass', component: BlankPage },
          ]),
          provideAuthedOidc(),
        ],
      }).compileComponents();
    });

    it('shellMode$ is "staff" on /staff/dashboard', async () => {
      const fixture = TestBed.createComponent(App);
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/staff/dashboard');
      const mode = await firstValueFrom(
        fixture.componentInstance.shellMode$.pipe(take(1))
      );
      expect(mode).toBe('staff');
    });

    it('shellMode$ is "public" on /reserva even when authenticated', async () => {
      const fixture = TestBed.createComponent(App);
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/reserva');
      const mode = await firstValueFrom(
        fixture.componentInstance.shellMode$.pipe(take(1))
      );
      expect(mode).toBe('public');
    });

    it('shellMode$ is "public" on /check-in/pass even when authenticated', async () => {
      const fixture = TestBed.createComponent(App);
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/check-in/pass');
      const mode = await firstValueFrom(
        fixture.componentInstance.shellMode$.pipe(take(1))
      );
      expect(mode).toBe('public');
    });

    it('shellMode$ is "public" on /reserva?eventDate=... (query string ignored)', async () => {
      const fixture = TestBed.createComponent(App);
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/reserva?eventDate=2026-05-16');
      const mode = await firstValueFrom(
        fixture.componentInstance.shellMode$.pipe(take(1))
      );
      expect(mode).toBe('public');
    });
  });
});
