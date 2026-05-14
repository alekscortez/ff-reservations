import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { take } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { SessionExpiry } from '../../../core/auth/session-expiry';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, HlmAlert, HlmButton],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private expiry = inject(SessionExpiry);

  showSessionExpired = signal(false);

  ngOnInit(): void {
    // Surface the "your session expired" banner if the interceptor or
    // silent-renew path bounced the user here. Read once on init — the
    // user dismisses by clicking "Log in", which navigates away.
    const reason = this.route.snapshot.queryParamMap.get('reason');
    if (reason === 'session-expired') this.showSessionExpired.set(true);

    // If we land on /login already authenticated (e.g. user opened the app
    // at the root URL — which redirects here — but their refresh token is
    // still valid), bounce them to the staff area. roleGuard will redirect
    // to /unauthorized if they don't actually have a Staff/Admin group, so
    // we don't replicate that dispatch here.
    this.auth
      .isAuthenticated$()
      .pipe(take(1))
      .subscribe((isAuthenticated) => {
        if (isAuthenticated) {
          this.expiry.reset();
          this.router.navigateByUrl('/staff/dashboard');
        }
      });
  }

  login(): void {
    this.expiry.reset();
    this.auth.login();
  }
}
