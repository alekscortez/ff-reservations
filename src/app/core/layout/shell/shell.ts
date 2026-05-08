import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Sidebar } from '../sidebar/sidebar';
import { AuthHealthBanner } from '../auth-health-banner/auth-health-banner';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, Sidebar, AuthHealthBanner],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {}
