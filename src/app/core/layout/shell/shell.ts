import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Sidebar } from '../sidebar/sidebar';
import { AuthHealthBanner } from '../auth-health-banner/auth-health-banner';
import { HlmSidebarInset } from '../../../shared/ui/sidebar';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, Sidebar, AuthHealthBanner, HlmSidebarInset],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {}
