import { Injectable, ElementRef, Injector, EventEmitter, RendererFactory2, Renderer2 } from '@angular/core';
import { MyAngularUiWebSocket, RequestType, MauRequestInfo, SendStates } from './mau-web-socket';
import { MauUtils } from './mau-utils';
import { Subscription } from 'rxjs';

export let AppInjector: Injector;

export interface MauComponentProp {
    Name: string;
    Value: any;
    Type: MauPropertyType;
    Status: MauPropertyStatus;
    NeedToPolling: boolean;

    /**
     * SafeToHandle is true if it's value is safe to set,
     * so it's just to not override angular prop value with bad values
     *
     * @type {boolean}
     * @memberof MauComponentProp
     */
    SafeToHandle: boolean;

    /**
     * Listen to property changes and send changes to .Net side
     *
     * @type {boolean}
     * @memberof MauComponentProp
     */
    Listen: boolean;
}

export interface MauComponentEvent {
    Name: string;
    Handled: boolean;
    Unsubscribe: () => void;
}

export interface MauComponent {
    Id: string;
    Native: ElementRef;
    Component: any;
    HandledEvents: Map<string, MauComponentEvent>;
    HandledProps: Map<string, MauComponentProp>;
}

enum MauPropertyType {
    NativeAttribute = 0,
    NativeProperty = 1,
    ComponentProperty = 2
}

enum MauPropertyStatus {
    Normal = 0,
    ReadOnly = 1
}

enum MauMethodType {
    NativeMethod = 0,
    ComponentMethod = 1,
}

@Injectable({
    providedIn: 'root'
})
export class MyAngularUiService {

    private static _reConnectTimeout: number = 1000; // ms
    private static _varSplitter: string = "#"; // front-end side only, just to split unique var names
    private static _wasConnected: boolean = false;

    private _webSock: MyAngularUiWebSocket;
    private _timerId: number;
    private _renderer: Renderer2;
    private _working: boolean;
    private _dotNetReady: boolean;
    private _mauVariables: Map<string, any>;
    private _ordersResponse: Map<number, any>;

    public OnConnect: EventEmitter<void>;
    public OnDisConnect: EventEmitter<void>;
    public OnDotNetReady: EventEmitter<void>;
    public OnCustomData: EventEmitter<any>;

    public IP: string;
    public Port: number;

    public MauComponents: Map<string, MauComponent>;
    public Mutation: MutationObserver;

    private MutationObserverCallBack(mutations: MutationRecord[]): void {
        mutations.forEach(async (mutation: MutationRecord) => {
            if (mutation.type == "attributes") {
                const mauComponentId: string = (<HTMLElement>mutation.target).getAttribute(MauUtils.SelectorName);
                const mauComponent: MauComponent = this.MauComponents.get(mauComponentId);
                const attribute: string = mutation.attributeName;

                if (mauComponent && mauComponent.HandledProps.has(attribute)) {
                    const propInfo = mauComponent.HandledProps.get(attribute);
                    if (propInfo.Listen) {
                        this.GetProp(0, mauComponent, MauPropertyType.NativeAttribute, attribute, true);
                    }
                }
            }
        });
    }

    private async PropertyPollingCallBack(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.IsConnected()) {
                return resolve();
            }

            // Check every `PollingHandledProp` it's value changed
            this.MauComponents.forEach((mauComponent) => {
                if (!mauComponent.Component || !mauComponent.Native) {
                    return;
                }

                mauComponent.HandledProps.forEach((propInfo: MauComponentProp) => {
                    if (!propInfo || !propInfo.NeedToPolling || !propInfo.Listen) {
                        return;
                    }

                    // Get value without send data to .Net Side
                    const propNewVal: any = this.GetProp(0, mauComponent, propInfo.Type, propInfo.Name, false);
                    if (!MauUtils.DeepEqual(propNewVal, propInfo.Value)) {
                        propInfo.Value = propNewVal;

                        // Send new value to .Net Side
                        propInfo.SafeToHandle = true;
                        this.GetProp(0, mauComponent, propInfo.Type, propInfo.Name, true);
                    }
                });
            });

            return resolve();
        });
    }

    constructor(
        private injector: Injector,
        private rFactory: RendererFactory2
    ) {
        AppInjector = this.injector;

        this._working = true;
        this._renderer = rFactory.createRenderer(null, null);
        this.OnConnect = new EventEmitter();
        this.OnDisConnect = new EventEmitter();
        this.OnDotNetReady = new EventEmitter();
        this.OnCustomData = new EventEmitter();

        this.MauComponents = new Map<string, MauComponent>();
        this._mauVariables = new Map<string, any>();
        this._ordersResponse = new Map<number, any>();

        this._webSock = new MyAngularUiWebSocket(this);
        this._webSock.OnMessageCB = this.OnMessage;
        this._webSock.OnConnect.subscribe(() => this.OnConnectCallback());
        this._webSock.OnDisConnect.subscribe(() => this.OnDisConnectCallback());

        // ! Use lambda expression to keep the context (this as `MyAngularUiService`)
        this.Mutation = new MutationObserver((mutations) => this.MutationObserverCallBack(mutations));
    }

    public Start(ip: string, port: number = 2911): void {
        if (this._webSock.IsRunning) {
            return;
        }

        this.IP = ip;
        this.Port = port;

        this._webSock.Start(`ws://${this.IP}:${this.Port}/MauHandler`, MyAngularUiService._reConnectTimeout);
        this._timerId = setInterval(async () => {
            await this.PropertyPollingCallBack();
        }, 150);
    }

    public Stop(): void {
        clearInterval(this._timerId);
        this._webSock.Stop();
        this.Mutation.disconnect();
    }

    public IsConnected(): boolean {
        return this._webSock?.IsConnected;
    }

    public IsDotNetReady(): boolean {
        return this._dotNetReady;
    }

    private OnConnectCallback(): void {
        // if .Net was connected before then it's lose the connection
        // then best thing here is to reload the page
        if (MyAngularUiService._wasConnected) {
            this._working = false;
            this.Stop();
            window.location.reload();
            return;
        }

        this.OnConnect.emit();
    }

    private OnDisConnectCallback(): void {
        this.OnDisConnect.emit();
    }

    public SendCustomData(id: string, data: any): boolean {
        if (!this.IsConnected()) {
            return false;
        }

        return this._webSock.SendRequest(null, RequestType.CustomData, { id: id, data: data }).Sent;
    }

    public SetElement(mauComponent: MauComponent): void {
        if (!mauComponent.Id) {
            throw new Error(`'MauId' can't be empty string!.`);
        }

        // Check if it not add before
        if (!this.MauComponents.has(mauComponent.Id)) {
            this.MauComponents.set(mauComponent.Id, mauComponent);
            if (mauComponent.Native) {
                this.Mutation.observe(mauComponent.Native.nativeElement, { attributes: true/*, characterData: true, childList: true, subtree: true */ });
            }
            return;
        }

        // Update Element
        const curElement: MauComponent = this.MauComponents.get(mauComponent.Id);

        // Check old component have same type as new one
        if (curElement.Component && typeof curElement.Component !== typeof mauComponent.Component) {
            throw new Error(`'mauComponentId' => '${mauComponent.Id}', New component type must be same as old one.`);
        }

        // Set new component
        curElement.Component = mauComponent.Component;

        // Check old DOM Element Type
        if (curElement.Native && typeof curElement.Native.nativeElement !== typeof mauComponent.Native.nativeElement) {
            throw new Error(`'mauComponentId' => '${mauComponent.Id}', New NativeElement type must be same as old one.`);
        }

        // Set new DOM
        curElement.Native = mauComponent.Native;

        // Re set event handlers
        this.SetEventHandler(curElement, Array.from(curElement.HandledEvents.keys()));
        this.Mutation.observe(mauComponent.Native.nativeElement, { attributes: true/*, characterData: true, childList: true, subtree: true */ });

        // Re set props handlers and values
        // Since `MauElementDirective.OnDestroy` set `Listen` to false
        curElement.HandledProps.forEach((prop: MauComponentProp) => {
            if (prop.SafeToHandle) {
                this.SetProp(curElement, prop.Type, prop.Name, prop.Value);
            }
            prop.Listen = true;
        });
    }

    public GetElement(mauId: string): MauComponent {
        return this.MauComponents.get(mauId);
    }

    private OnMessage(msg: any): void {
        if (!this._working) {
            return;
        }

        MyAngularUiService._wasConnected = true;

        // Handle response
        let request: MauRequestInfo = {
            RequestId: msg["requestId"],
            MauComponent: this.GetElement(msg["mauComponentId"]),
            RequestType: msg["requestType"],
            Data: msg["data"]
        };

        if (request.MauComponent === undefined && MauUtils.IsNonEmptyString(msg["mauComponentId"])) {

            // Add new item, it's like early init, good for some stuff like MauVariables
            this.SetElement({
                Id: msg["mauComponentId"],
                Native: undefined,
                Component: undefined,
                HandledEvents: new Map<string, MauComponentEvent>(),
                HandledProps: new Map<string, MauComponentProp>()
            });

            request.MauComponent = this.GetElement(msg["mauComponentId"]);
        }

        // ! for request not need [MauComponent.(Component || Native)], ex: just need 'RequestType' and 'Data'.
        switch (request.RequestType) {
            case RequestType.SetEvents:
                this.SetEventHandler(request.MauComponent, request.Data["events"]);
                break;

            case RequestType.GetPropValue:
            case RequestType.SetPropValue:
                this.SetPropHandler(request.MauComponent, request.Data["propType"], request.Data["propStatus"], request.Data["propName"], request.Data["propVal"]);
                break;

            case RequestType.SetVarValue:
                this.SetVar(request.MauComponent.Id + MyAngularUiService._varSplitter + request.Data["varName"], request.Data["varValue"]);
                break;

            /*case RequestType.ExecuteCode:
                this.ExecuteCode(request.MauComponent, request.Data["code"]);
                break;*/

            case RequestType.DotNetReady:
                this._dotNetReady = true;
                this.OnDotNetReady.emit();
                break;

            case RequestType.CustomData:
                new Promise((resolve, reject) => {
                    this.OnCustomData.emit({ id: request.Data["id"], data: request.Data["data"] });
                    return resolve();
                });
                break;

            default:
                break;
        }

        // ! for request need full init MauComponent.
        if (request.MauComponent?.Component === undefined) {
            return;
        }

        switch (request.RequestType) {
            case RequestType.GetPropValue:
                this.GetProp(request.RequestId, request.MauComponent, request.Data["propType"], request.Data["propName"], true);
                break;

            case RequestType.SetPropValue:
                this.SetProp(request.MauComponent, request.Data["propType"], request.Data["propName"], request.Data["propVal"]);
                break;

            case RequestType.CallMethod:
                this.CallMethod(request.RequestId, request.MauComponent, request.Data["methodType"], request.Data["methodName"], request.Data["methodArgs"]);
                break;

            case RequestType.CallNetMethod:
                this._ordersResponse.set(request.RequestId, request.Data["methodRet"])
                break;

            case RequestType.SetStyle:
                this.SetStyle(request.MauComponent, request.Data["styleName"], request.Data["styleValue"]);
                break;

            case RequestType.RemoveStyle:
                this.RemoveStyle(request.MauComponent, request.Data["styleName"]);
                break;

            case RequestType.AddClass:
                this.AddClass(request.MauComponent, request.Data["className"]);
                break;

            case RequestType.RemoveClass:
                this.RemoveClass(request.MauComponent, request.Data["className"]);
                break;

            default:
                break;
        }
    }

    private async FireEvent(mauComponent: MauComponent, eventName: string, event: Event): Promise<void> {
        // * call `PropertyPollingCallBack`, so if the property affected by the event
        // * then changed properties will sent before event
        await this.PropertyPollingCallBack();

        let eName: string = event?.type ? event.type : eventName;
        let eType: string = event?.constructor.name ? event?.constructor.name : eName;

        this._webSock.SendEventCallback(mauComponent, eName, eType, MauUtils.ObjectToJson(event));
    }

    private SetEventHandler(mauComponent: MauComponent, events: string[]): void {
        // Set Event
        events.forEach((eventName: string) => {
            mauComponent.HandledEvents.set(eventName, { Name: eventName, Handled: false, Unsubscribe: undefined });
        })

        if (!mauComponent.Component) {
            return;
        }

        // Set event handler
        mauComponent.HandledEvents.forEach((eventInfo: MauComponentEvent, eventName: string) => {
            // Access event as property
            const eventProp: any = mauComponent.Component[eventName];

            // * Set subscribe to EventEmitter, that's for some custom components
            // * Like Angular Material components (MatSelect, ...)
            if (eventProp !== undefined && typeof eventProp !== "function") {
                const sub: Subscription = (eventProp.subscribe((event: MessageEvent) => {
                    this.FireEvent(mauComponent, eventName, event);
                }) as Subscription);

                eventInfo.Unsubscribe = () => sub.unsubscribe();
                eventInfo.Handled = true;
            }
            // * Add normal listener if it's normal HTML Element
            else if (mauComponent.Native) {
                eventInfo.Unsubscribe = this._renderer.listen(mauComponent.Native.nativeElement, eventName, (event: Event) => {
                    this.FireEvent(mauComponent, eventName, event);
                });
                eventInfo.Handled = true;
            }
            else {
                throw new Error(`Event '${eventName}' not found.`);
            }
        });
    }

    private GetProp(requestId: number, mauComponent: MauComponent, propType: MauPropertyType, propName: string, wsSend: boolean): any {
        if (!mauComponent) {
            return null;
        }

        let propHandled: boolean = mauComponent.HandledProps.has(propName);
        let propHandledSameType: boolean = propHandled && mauComponent.HandledProps.get(propName).Type == propType;

        let val: any;
        // * Get value of the property
        switch (propType) {
            case MauPropertyType.NativeAttribute:
                val = mauComponent.Native.nativeElement.getAttribute(propName);
                break;

            case MauPropertyType.NativeProperty:
                if (!mauComponent.Native) {
                    break;
                }
                val = mauComponent.Native.nativeElement[propName] ?? mauComponent.Component[propName];
                break;

            case MauPropertyType.ComponentProperty:
                if (!mauComponent.Component) {
                    break;
                }
                val = mauComponent.Component[propName];
                break;
        }

        // ! Maybe val is Boolean so (val ? val : null) will be bad
        val = val !== undefined ? val : null;

        if (wsSend && propHandled && propHandledSameType)
            this._webSock.Send(requestId, mauComponent, RequestType.GetPropValue, { propName: propName, propValue: val });

        return val;
    }

    private SetProp(mauComponent: MauComponent, propType: MauPropertyType, propName: string, propVal: any): void {
        switch (propType) {
            case MauPropertyType.NativeAttribute:
                mauComponent.Native.nativeElement.setAttribute(propName, propVal);
                break;

            case MauPropertyType.NativeProperty:
                mauComponent.Native.nativeElement[propName] = propVal;
                break;

            case MauPropertyType.ComponentProperty:
                if (!(propName in mauComponent.Component)) {
                    return;
                }
                try {
                    mauComponent.Component[propName] = propVal;
                } catch (error) {
                    // * So this prop not have a setter
                }
                break;
        }
    }

    /**
     * this function help to fetch when prop value changed
     * then send new info to .Net Side
     *
     * @private
     * @param {string} mauComponent MauComponent
     * @param {MauPropertyType} propType Property type to know how to handle
     * @param {MauPropertyStatus} propStatus Property status to know how to handle
     * @param {string} propName Property name to set handle on it
     * @memberof MyAngularUiService
     */
    private SetPropHandler(mauComponent: MauComponent, propType: MauPropertyType, propStatus: MauPropertyStatus, propName: string, propVal: any = undefined): void {
        if (mauComponent.HandledProps.has(propName)) {
            return;
        }

        // NativeAttribute not need to be handled
        // MutationObserver will take care of it
        mauComponent.HandledProps.set(propName, {
            Name: propName,
            Type: propType,
            Status: propStatus,
            Value: propVal,
            NeedToPolling: propType != MauPropertyType.NativeAttribute,
            SafeToHandle: propVal !== undefined,
            Listen: true
        });
    }

    private CallMethod(requestId: number, mauComponent: MauComponent, methodType: MauMethodType, methodName: string, methodArgs: any): void {
        let methodRet: any;
        switch (methodType) {
            case MauMethodType.NativeMethod:
                methodRet = mauComponent.Native[methodName].call(mauComponent.Native, ...methodArgs)
                break;

            case MauMethodType.ComponentMethod:
                methodRet = mauComponent.Component[methodName].call(mauComponent.Component, ...methodArgs)
                break;
        }

        // if function return promise, will resolve first
        // if not promise will send to .Net directly
        Promise.resolve(methodRet).then((value) => {
            // Send method return value
            // ! Must send return value to .Net side even it's void or undefined
            this._webSock.Send(requestId, mauComponent, RequestType.ReceiveMethod, {
                methodName: methodName,
                methodRet: value === undefined ? null : value
            });
        })
    }

    private GetMethodRetValue(callMethodRequestId: number): Promise<any> {
        return new Promise<any>(async (resolve, reject) => {
            while (!this._ordersResponse.has(callMethodRequestId) && this.IsConnected()) {
                await new Promise(resolve => setTimeout(resolve, 1) );
            }

            if (!this.IsConnected())
                return reject("Connection lost");

            // Get and remove data
            if (this._ordersResponse.has(callMethodRequestId)) {
                const ret: any = this._ordersResponse.get(callMethodRequestId);
                this._ordersResponse.delete(callMethodRequestId);
                return resolve(ret);
            }

            return reject("Can't get return value");
        });

    }

    public CallNetMethod(holderName: string, methodName: string, ...methodArgs: any): Promise<any> {
        return new Promise<any>(async (resolve, reject) => {
            const mauComponent: MauComponent = this.GetElement(holderName);

            if (!mauComponent) {
                return reject(`'${holderName}' MauComponent not found`);
            }

            // Send call to .Net
            const callRequest: SendStates = this._webSock.SendRequest(mauComponent, RequestType.CallNetMethod, { methodName: methodName, methodArgs: methodArgs });
            if (!callRequest.Sent) {
                return reject("'CallNetMethod' request can't be done !");
            }

            // Wait for response
            const ret: any = await this.GetMethodRetValue(callRequest.RequestId);
            return resolve(ret);
        });
    }

    /*private ExecuteCode(mauComponent: MauComponent, code: string): void {
        // Access the element (So in TS code just use 'mauComponentId' to access the mauComponent)
        let elSelector: string = `let elCorrM = this.MauComponents.get(mauComponent.Id).Native.nativeElement;`;
        code = code.replace(mauComponent.Id, "elCorrM");
        code = `${elSelector}\n${code}`;

        const codeExecuter = {
            Run: (pString: string) => {
                return eval(pString)
            }
        };

        codeExecuter.Run.call(this, code);
    }*/

    private SetVar(varName: string, varVal: any): void {
        this._mauVariables.set(varName, varVal);
    }

    public GetVar(holderName: string, varName: string): any {
        let fullVarName = `${holderName}${MyAngularUiService._varSplitter}${varName}`;

        return this._mauVariables.has(fullVarName)
            ? this._mauVariables.get(fullVarName)
            : null;
    }

    private SetStyle(mauComponent: MauComponent, style: string, value: string): void {
        this._renderer.setStyle(mauComponent.Native.nativeElement, style, value);
    }

    private RemoveStyle(mauComponent: MauComponent, style: string): void {
        this._renderer.removeStyle(mauComponent.Native.nativeElement, style);
    }

    private AddClass(mauComponent: MauComponent, className: string): void {
        this._renderer.addClass(mauComponent.Native.nativeElement, className);
    }

    private RemoveClass(mauComponent: MauComponent, className: string): void {
        this._renderer.removeClass(mauComponent.Native.nativeElement, className);
    }
}
