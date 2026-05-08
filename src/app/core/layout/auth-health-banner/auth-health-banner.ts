import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AdminService } from '../../http/admin.service';

@Component({
  selector: 'app-auth-health-banner',
  imports: [CommonModule],
  template: `
    @if (showMissingGroups()) {
      <div
        role="alert"
        class="m-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
      >
        <strong class="block font-semibold">Auth misconfigured</strong>
        Your access token is missing the <code>cognito:groups</code> claim.
        The Cognito Pre Token Generation Lambda is likely not deployed or
        not wired to this user pool. See
        <code>backend/cognito-pre-token-gen/README.md</code>. After
        deploying, sign out and back in.
      </div>
    } @else if (showAuthError()) {
      <div
        role="alert"
        class="m-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        Could not verify auth status. If sensitive features fail, reload
        and sign in again.
      </div>
    }
  `,
})
export class AuthHealthBanner implements OnInit {
  private admin = inject(AdminService);
  showMissingGroups = signal(false);
  showAuthError = signal(false);

  ngOnInit(): void {
    this.admin.whoami().subscribe({
      next: (res) => {
        this.showMissingGroups.set(Boolean(res?.diagnostic?.missingGroupsLikelyPreTokenGen));
        this.showAuthError.set(false);
      },
      error: (err) => {
        // 401 means auth is broken in some other way — not the pre-token-gen
        // case but still worth surfacing so a staff user knows reload helps.
        const status = Number(err?.status ?? 0);
        if (status === 401 || status === 403) {
          this.showAuthError.set(true);
        }
      },
    });
  }
}
