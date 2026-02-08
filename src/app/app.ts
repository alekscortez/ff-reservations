import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { buildCognitoLogoutUrl } from './core/config/app-config';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet],
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
    // Local cleanup
    this.oidc.logoffLocal();
    window.sessionStorage.clear();
    window.localStorage.clear();

    // Cognito Hosted UI logout
    const logoutUrl = buildCognitoLogoutUrl(window.location.origin);
    window.location.replace(logoutUrl);
  }
}
