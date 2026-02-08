import {Component, OnInit, inject} from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';

@Component({
  selector: 'app-home',
  imports: [],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home implements OnInit {
  private oidc = inject(OidcSecurityService);

  ngOnInit(): void {
    // 🔑 ACCESS TOKEN (this is what API Gateway wants)
    this.oidc.getAccessToken().subscribe(token => {
      console.log('ACCESS TOKEN:', token);
    });

    // (Optional) ID TOKEN – useful for groups, not for API Gateway
    this.oidc.getIdToken().subscribe(token => {
      console.log('ID TOKEN:', token);
    });
  }

}
