import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
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

  isAuthenticated = false;
  userData$ = this.oidc.userData$;

  ngOnInit(): void {
    this.oidc.checkAuth().subscribe();
    this.oidc.isAuthenticated$.subscribe(({ isAuthenticated }) => {
      this.isAuthenticated = isAuthenticated;
    });

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
