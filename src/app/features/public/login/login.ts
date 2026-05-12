import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { take } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { HlmButton } from '../../../shared/ui/button';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, HlmButton],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  ngOnInit(): void {
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
          this.router.navigateByUrl('/staff/dashboard');
        }
      });
  }

  login(): void {
    this.auth.login();
  }
}
