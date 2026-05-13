import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { decodeJwt, normalizeGroupsClaim } from '../../../core/auth/jwt';

@Component({
  selector: 'app-auth-callback',
  imports: [],
  templateUrl: './auth-callback.html',
  styleUrl: './auth-callback.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
        const claims = decodeJwt(token);
        const groups = normalizeGroupsClaim(claims?.['cognito:groups']);

        if (groups.includes('Admin') || groups.includes('Staff')) {
          this.router.navigateByUrl('/staff/dashboard');
          return;
        }

        this.router.navigateByUrl('/unauthorized');
      });
    });
  }
}
