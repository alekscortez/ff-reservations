import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-topbar',
  imports: [CommonModule, RouterLink],
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  private auth = inject(AuthService);

  name$ = this.auth.displayName$();
  role$ = this.auth.roleLabel$();
  isAuthenticated$ = this.auth.isAuthenticated$();

  login(): void {
    this.auth.login();
  }

  logout(): void {
    this.auth.logout();
  }
}
