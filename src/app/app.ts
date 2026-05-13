import { Component, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import { combineLatest, filter, map, startWith } from 'rxjs';
import { Topbar } from './core/layout/topbar/topbar';
import { HlmSidebarWrapper } from './shared/ui/sidebar';

// Routes that always render in the clean public shell — no staff topbar /
// sidebar — even when a staff member is signed in. Without this, staff
// previewing /map see their own dashboard chrome and can't tell what a
// customer actually gets.
const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/unauthorized',
  '/check-in/pass',
  '/map',
  '/pay',
];

function isPublicPath(url: string): boolean {
  const path = String(url ?? '').split('?')[0].split('#')[0];
  if (!path || path === '/') return false;
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, Topbar, HlmSidebarWrapper],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private oidc = inject(OidcSecurityService);
  private oidcEvents = inject(PublicEventsService);
  private router = inject(Router);

  private isAuthenticated$ = this.oidc.isAuthenticated$.pipe(
    map((r) => r.isAuthenticated)
  );
  userData$ = this.oidc.userData$;

  // Re-emits on every NavigationEnd. We start with a null tick so the
  // combineLatest below fires before any navigation completes (e.g. on
  // first paint after bootstrap). The actual URL is read from
  // `router.url` inside the map so late subscribers always see the
  // current route, not a snapshot captured at construction time.
  private routerChanges$ = this.router.events.pipe(
    filter((e): e is NavigationEnd => e instanceof NavigationEnd),
    startWith(null as NavigationEnd | null)
  );

  // 'staff' = topbar + sidebar wrapper; 'public' = bare router-outlet.
  // Async pipe in the template — avoids a manual boolean field that could
  // briefly race against the bootstrap's checkAuth() emission.
  shellMode$ = combineLatest([this.isAuthenticated$, this.routerChanges$]).pipe(
    map(([authed]) =>
      authed && !isPublicPath(this.router.url) ? 'staff' : 'public'
    )
  );

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
