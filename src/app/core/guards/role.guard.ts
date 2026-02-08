import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { map, take } from 'rxjs';

export function roleGuard(allowed: string[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    return auth.groups$().pipe(
      take(1),
      map(groups =>
        allowed.some(r => groups.includes(r))
          ? true
          : router.createUrlTree(['/unauthorized'])
      )
    );
  };
}
