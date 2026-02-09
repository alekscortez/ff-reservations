import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { OidcSecurityService } from 'angular-auth-oidc-client';
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

  isAuthenticated = false;
  userData$ = this.oidc.userData$;

  ngOnInit(): void {
    // 🔴 REQUIRED — initializes auth state
    this.oidc.checkAuth().subscribe((result) => {
      console.log('[checkAuth]', result);

      // ✅ DEV ONLY: log refresh token once after successful auth
      if (result.isAuthenticated) {
        this.oidc.getAuthenticationResult().subscribe((r) => {
          console.log('REFRESH TOKEN (dev only):', r?.refresh_token);
        });
      }
    });

    this.oidc.isAuthenticated$.subscribe(({ isAuthenticated }) => {
      this.isAuthenticated = isAuthenticated;
      console.log('[isAuthenticated]', isAuthenticated);
    });
  }

  login(): void {
    this.oidc.authorize();
  }

  logout(): void {
    this.oidc.logoff();
  }
}
