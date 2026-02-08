import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';

@Component({
  selector: 'app-auth-callback',
  imports: [],
  templateUrl: './auth-callback.html',
  styleUrl: './auth-callback.scss',
})
export class AuthCallback implements OnInit {
  private oidc = inject(OidcSecurityService);
  private router = inject(Router);

  ngOnInit(): void {
    this.oidc.checkAuth().subscribe(({ isAuthenticated }) => {
      if (!isAuthenticated) {
        this.router.navigateByUrl('/unauthorized');
        return;
      }

      // Use ID token groups to decide where to send the user
      this.oidc.getIdToken().subscribe((token) => {
        const groups: string[] = decodeGroups(token);

        if (groups.includes('Admin')) {
          this.router.navigateByUrl('/admin/dashboard');
          return;
        }

        if (groups.includes('Staff')) {
          this.router.navigateByUrl('/staff/dashboard');
          return;
        }

        this.router.navigateByUrl('/unauthorized');
      });
    });
  }
}

function decodeGroups(token: string | null | undefined): string[] {
  if (!token) return [];
  const parts = token.split('.');
  if (parts.length !== 3) return [];
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const claims = JSON.parse(atob(payload));
    return claims?.['cognito:groups'] ?? [];
  } catch {
    return [];
  }
}
