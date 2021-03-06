import { Injectable } from '@angular/core';
import { CanActivate, ActivatedRouteSnapshot, Router } from '@angular/router';
import { MyAngularUiService } from './mau.service';

@Injectable({
    providedIn: 'root'
})
export class MauConnectedGuard implements CanActivate {

    constructor(private router: Router, private mau: MyAngularUiService) {}

    public canActivate(next: ActivatedRouteSnapshot): boolean {
        if (!this.mau.IsConnected()) {
            let url = next.data.connectUrl as Array<string>;
            this.router.navigate(url);
            return false;
        }
        
        return true;
    }
}
