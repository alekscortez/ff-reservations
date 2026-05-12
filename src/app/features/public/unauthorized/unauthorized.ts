import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { AuthService } from '../../../core/auth/auth.service';
import { HlmButton } from '../../../shared/ui/button';

@Component({
  selector: 'app-unauthorized',
  imports: [HlmButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './unauthorized.html',
  styleUrl: './unauthorized.scss',
})
export class Unauthorized {
  private auth = inject(AuthService);

  signOut(): void {
    this.auth.logout();
  }
}
