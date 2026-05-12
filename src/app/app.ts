import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import { map } from 'rxjs';
import { Topbar } from './core/layout/topbar/topbar';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, Topbar],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private oidc = inject(OidcSecurityService);
  private oidcEvents = inject(PublicEventsService);

  // Async pipe in the template — avoids a manual boolean field that could
  // briefly race against the bootstrap's checkAuth() emission.
  isAuthenticated$ = this.oidc.isAuthenticated$.pipe(
    map((r) => r.isAuthenticated)
  );
  userData$ = this.oidc.userData$;

  ngOnInit(): void {
    // provideAppInitializer (app.config.ts) already calls oidc.checkAuth()
    // during bootstrap. Subscribing to isAuthenticated$ via the async pipe
    // in the template is enough — no extra checkAuth() call here.

    // Diagnostic-only: log OIDC lifecycle events when the ff-debug flag
    // is set. Lets us verify on mobile (via eruda) whether silent renewal
    // actually fires before access tokens expire. No-op for real users.
    try {
      if (
        typeof window !== 'undefined' &&
        window.localStorage?.getItem('ff-debug') === '1'
      ) {
        this.oidcEvents.registerForEvents().subscribe((evt) => {
          const name = EventTypes[evt?.type] ?? `Type${evt?.type}`;
          // Don't dump payload — could include tokens.
          console.info(`[oidc] ${name}`);
        });
      }
    } catch {
      // never let debug logging break bootstrap
    }
  }

  login(): void {
    this.oidc.authorize();
  }

  logout(): void {
    this.oidc.logoff();
  }
}
