import { Component, Renderer2, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule, DOCUMENT } from '@angular/common';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-sidebar',
  imports: [CommonModule, RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  private auth = inject(AuthService);
  private renderer = inject(Renderer2);
  private doc = inject(DOCUMENT);

  groups$ = this.auth.groups$();
  isAdmin$ = this.auth.hasGroup$('Admin');
  isStaff$ = this.auth.hasGroup$('Staff');
  isAuthenticated$ = this.auth.isAuthenticated$();
  name$ = this.auth.displayName$();
  role$ = this.auth.roleLabel$();

  closeMobileNav(): void {
    this.renderer.removeClass(this.doc.body, 'mobile-nav-open');
    this.renderer.removeClass(this.doc.documentElement, 'mobile-nav-open');
  }

  logout(): void {
    this.closeMobileNav();
    this.auth.logout();
  }
}
