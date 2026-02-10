import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-sidebar',
  imports: [CommonModule, RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  private auth = inject(AuthService);

  groups$ = this.auth.groups$();
  isAdmin$ = this.auth.hasGroup$('Admin');
  isStaff$ = this.auth.hasGroup$('Staff');

  closeMobileNav(): void {
    document.body.classList.remove('mobile-nav-open');
    document.documentElement.classList.remove('mobile-nav-open');
  }
}
