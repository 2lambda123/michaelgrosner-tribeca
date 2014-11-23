/// <reference path="../typings/tsd.d.ts" />
/// <reference path="utils.ts" />
/// <reference path="models.ts" />
/// <reference path="null.ts" />

import Config = require("config");
import crypto = require('crypto');
import ws = require('ws');
import request = require('request');
import url = require("url");
import querystring = require("querystring");

var _lotMultiplier = 100.0;

interface NoncePayload<T> {
    nonce: number;
    payload: T;
}

interface AuthorizedHitBtcMessage<T> {
    apikey : string;
    signature : string;
    message : NoncePayload<T>;
}

interface HitBtcPayload {
}

interface Login extends HitBtcPayload {
}

interface NewOrder extends HitBtcPayload {
    clientOrderId : string;
    symbol : string;
    side : string;
    quantity : number;
    type : string;
    price : number;
    timeInForce : string;
}

interface OrderCancel extends HitBtcPayload {
    clientOrderId : string;
    cancelRequestClientOrderId : string;
    symbol : string;
    side : string;
}

interface HitBtcOrderBook {
    asks : Array<Array<string>>;
    bids : Array<Array<string>>;
}

interface Update {
    price : number;
    size : number;
    timestamp : number;
}

class SideUpdate {
    constructor(public price: number, public size: number) {}
}

interface MarketDataSnapshotFullRefresh {
    snapshotSeqNo : number;
    symbol : string;
    exchangeStatus : string;
    ask : Array<Update>;
    bid : Array<Update>
}

interface MarketDataIncrementalRefresh {
    seqNo : number;
    timestamp : number;
    symbol : string;
    exchangeStatus : string;
    ask : Array<Update>;
    bid : Array<Update>
    trade : Array<Update>
}

interface ExecutionReport {
    orderId : string;
    clientOrderId : string;
    execReportType : string;
    orderStatus : string;
    orderRejectReason? : string;
    symbol : string;
    side : string;
    timestamp : number;
    price : number;
    quantity : number;
    type : string;
    timeInForce : string;
    tradeId? : string;
    lastQuantity? : number;
    lastPrice? : number;
    leavesQuantity? : number;
    cumQuantity? : number;
    averagePrice? : number;
}

interface CancelReject {
    clientOrderId : string;
    cancelRequestClientOrderId : string;
    rejectReasonCode : string;
    rejectReasonText : string;
    timestamp : number;
}

class HitBtcMarketDataGateway implements IMarketDataGateway {
    MarketData = new Evt<MarketUpdate>();
    _marketDataWs : any;

    _lastBook : { [side: string] : { [px: number]: number}} = null;
    private onMarketDataIncrementalRefresh = (msg : MarketDataIncrementalRefresh, t : Moment) => {
        if (msg.symbol != "BTCUSD" || this._lastBook == null) return;

        var ordBids = HitBtcMarketDataGateway._applyIncrementals(msg.bid, this._lastBook["bid"], (a, b) => a.price > b.price ? -1 : 1);
        var ordAsks = HitBtcMarketDataGateway._applyIncrementals(msg.ask, this._lastBook["ask"], (a, b) => a.price > b.price ? 1 : -1);

        var getLevel = (n : number) => {
            var bid = new MarketSide(ordBids[n].price, ordBids[n].size);
            var ask = new MarketSide(ordAsks[n].price, ordAsks[n].size);
            return new MarketUpdate(bid, ask, t);
        };

        this.MarketData.trigger(getLevel(0));
    };

    private static _applyIncrementals(incomingUpdates : Update[],
                               side : { [px: number]: number},
                               cmp : (p1 : SideUpdate, p2 : SideUpdate) => number) {
        for (var i = 0; i < incomingUpdates.length; i++) {
            var u : Update = incomingUpdates[i];
            if (u.size == 0) {
                delete side[u.price];
            }
            else {
                side[u.price] = u.size;
            }
        }

        var kvps : SideUpdate[] = [];
        for (var px in side) {
            kvps.push(new SideUpdate(parseFloat(px), side[px] / _lotMultiplier));
        }
        return kvps.sort(cmp);
    }

    private static getLevel(msg : MarketDataSnapshotFullRefresh, n : number, t : Moment) : MarketUpdate {
        var bid = new MarketSide(msg.bid[n].price, msg.bid[n].size / _lotMultiplier);
        var ask = new MarketSide(msg.ask[n].price, msg.ask[n].size / _lotMultiplier);
        return new MarketUpdate(bid, ask, t);
    }

    private onMarketDataSnapshotFullRefresh = (msg : MarketDataSnapshotFullRefresh, t : Moment) => {
        if (msg.symbol != "BTCUSD") return;

        this._lastBook = {bid: {}, ask: {}};

        for (var i = 0; i < msg.ask.length; i++) {
            this._lastBook["ask"][msg.ask[i].price] = msg.ask[i].size;
        }

        for (var i = 0; i < msg.bid.length; i++) {
            this._lastBook["bid"][msg.bid[i].price] = msg.bid[i].size;
        }

        var b = HitBtcMarketDataGateway.getLevel(msg, 0, t);
        this.MarketData.trigger(b);
    };

    private onMessage = (raw : string) => {
        var t = date();

        try {
            var msg = JSON.parse(raw);
        }
        catch (e) {
            this._log("Error parsing msg %o", raw);
            throw e;
        }

        if (msg.hasOwnProperty("MarketDataIncrementalRefresh")) {
            this.onMarketDataIncrementalRefresh(msg.MarketDataIncrementalRefresh, t);
        }
        else if (msg.hasOwnProperty("MarketDataSnapshotFullRefresh")) {
            this.onMarketDataSnapshotFullRefresh(msg.MarketDataSnapshotFullRefresh, t);
        }
        else {
            this._log("unhandled message", msg);
        }
    };

    ConnectChanged : Evt<ConnectivityStatus> = new Evt<ConnectivityStatus>();
    private onOpen = () => {
        this.ConnectChanged.trigger(ConnectivityStatus.Connected);
    };

     _log : Logger = log("tribeca:gateway:HitBtcMD");
    constructor(config : Config.IConfigProvider) {
        this._marketDataWs = new ws(config.GetString("HitBtcMarketDataUrl"));
        this._marketDataWs.on('open', this.onOpen);
        this._marketDataWs.on('message', this.onMessage);
        this._marketDataWs.on("error", this.onMessage);

        request.get(
            {url: url.resolve(config.GetString("HitBtcPullUrl"), "/api/1/public/BTCUSD/orderbook")},
            (err, body, resp) => {
                this.onMarketDataSnapshotFullRefresh(resp, date());
            });
    }
}

class HitBtcOrderEntryGateway implements IOrderEntryGateway {
    OrderUpdate : Evt<OrderStatusReport> = new Evt<OrderStatusReport>();
    _orderEntryWs : any;

    _nonce = 1;

    cancelOrder = (cancel : BrokeredCancel) : OrderGatewayActionReport => {
        this.sendAuth("OrderCancel", {clientOrderId: cancel.clientOrderId,
            cancelRequestClientOrderId: cancel.requestId,
            symbol: "BTCUSD",
            side: HitBtcOrderEntryGateway.getSide(cancel.side)});
        return new OrderGatewayActionReport(date());
    };

    replaceOrder = (replace : BrokeredReplace) : OrderGatewayActionReport => {
        this.cancelOrder(new BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
        return this.sendOrder(replace);
    };

    sendOrder = (order : BrokeredOrder) : OrderGatewayActionReport => {
        var hitBtcOrder : NewOrder = {
            clientOrderId: order.orderId,
            symbol: "BTCUSD",
            side: HitBtcOrderEntryGateway.getSide(order.side),
            quantity: order.quantity * _lotMultiplier,
            type: HitBtcOrderEntryGateway.getType(order.type),
            price: order.price,
            timeInForce: HitBtcOrderEntryGateway.getTif(order.timeInForce)
        };

        this.sendAuth("NewOrder", hitBtcOrder);
        return new OrderGatewayActionReport(date());
    };

    private static getStatus(m : ExecutionReport) : OrderStatus {
        switch (m.execReportType) {
            case "new":
            case "status":
                return OrderStatus.Working;
            case "canceled":
                return OrderStatus.Cancelled;
            case "expired":
                return OrderStatus.Complete;
            case "rejected":
                return OrderStatus.Rejected;
            case "trade":
                if (m.orderStatus == "filled")
                    return OrderStatus.Complete;
                else
                    return OrderStatus.Working;
            default:
                return OrderStatus.Other;
        }
    }

    private static getTif(tif : TimeInForce) {
        switch (tif) {
            case TimeInForce.FOK:
                return "FOK";
            case TimeInForce.GTC:
                return "GTC";
            case TimeInForce.IOC:
                return "IOC";
            default:
                throw new Error("TIF " + TimeInForce[tif] + " not supported in HitBtc");
        }
    }

    private static getSide(side : Side) {
        switch (side) {
            case Side.Bid:
                return "buy";
            case Side.Ask:
                return "sell";
            default:
                throw new Error("Side " + Side[side] + " not supported in HitBtc");
        }
    }

    private static getType(t : OrderType) {
        switch (t) {
            case OrderType.Limit:
                return "limit";
            case OrderType.Market:
                return "market";
            default:
                throw new Error("OrderType " + OrderType[t] + " not supported in HitBtc");
        }
    }

    private onExecutionReport = (tsMsg : Timestamped<ExecutionReport>) => {
        var t = tsMsg.time;
        var msg = tsMsg.data;

        var ordStatus = HitBtcOrderEntryGateway.getStatus(msg);
        var status : OrderStatusReport = {
            exchangeId: msg.orderId,
            orderId: msg.clientOrderId,
            orderStatus: ordStatus,
            time: t,
            rejectMessage: msg.orderRejectReason,
            lastQuantity: msg.lastQuantity > 0 ? msg.lastQuantity / _lotMultiplier : undefined,
            lastPrice: msg.lastQuantity > 0 ? msg.lastPrice : undefined,
            leavesQuantity: ordStatus == OrderStatus.Working ? msg.leavesQuantity / _lotMultiplier : undefined,
            cumQuantity: msg.cumQuantity / _lotMultiplier,
            averagePrice: msg.averagePrice
        };

        this.OrderUpdate.trigger(status);
    };

    private onCancelReject = (tsMsg : Timestamped<CancelReject>) => {
        var msg = tsMsg.data;
        var status : OrderStatusReport = {
            orderId: msg.clientOrderId,
            rejectMessage: msg.rejectReasonText,
            orderStatus: OrderStatus.Rejected,
            cancelRejected: true,
            time: tsMsg.time
        };
        this.OrderUpdate.trigger(status);
    };

    private authMsg = <T>(payload : T) : AuthorizedHitBtcMessage<T> => {
        var msg = {nonce: this._nonce, payload: payload};
        this._nonce += 1;

        var signMsg = m => {
            return crypto.createHmac('sha512', this._secret)
                .update(JSON.stringify(m))
                .digest('base64');
        };

        return {apikey: this._apiKey, signature: signMsg(msg), message: msg};
    };

    private sendAuth = <T extends HitBtcPayload>(msgType : string, msg : T) => {
        var v = {};
        v[msgType] = msg;
        var readyMsg = this.authMsg(v);
        this._orderEntryWs.send(JSON.stringify(readyMsg));
    };

    ConnectChanged : Evt<ConnectivityStatus> = new Evt<ConnectivityStatus>();
    private onOpen = () => {
        this.sendAuth("Login", {});
        this.ConnectChanged.trigger(ConnectivityStatus.Connected);
    };

    private onMessage = (raw : string) => {
        var t = date();
        var msg = JSON.parse(raw);
        if (msg.hasOwnProperty("ExecutionReport")) {
            this.onExecutionReport(new Timestamped(msg.ExecutionReport, t));
        }
        else if (msg.hasOwnProperty("CancelReject")) {
            this.onCancelReject(new Timestamped(msg.CancelReject, t));
        }
        else {
            this._log("unhandled message", msg);
        }
    };

     _log : Logger = log("tribeca:gateway:HitBtcOE");
    private _apiKey : string;
    private _secret : string;
    constructor(config : Config.IConfigProvider) {
        this._apiKey = config.GetString("HitBtcApiKey");
        this._secret = config.GetString("HitBtcSecret");
        this._orderEntryWs = new ws(config.GetString("HitBtcOrderEntryUrl"));
        this._orderEntryWs.on('open', this.onOpen);
        this._orderEntryWs.on('message', this.onMessage);
        this._orderEntryWs.on("error", this.onMessage);
    }
}

interface HitBtcPositionReport {
    currency_code : string;
    cash : number;
    reserved : number;
}

class HitBtcPositionGateway implements IPositionGateway {
    _log : Logger = log("tribeca:gateway:HitBtcPG");
    PositionUpdate : Evt<CurrencyPosition> = new Evt<CurrencyPosition>();

    private getAuth = (uri : string) : any => {
        var nonce : number = new Date().getTime() * 1000; // get rid of *1000 after getting new keys
        var comb = uri + "?" + querystring.stringify({nonce: nonce, apikey: this._apiKey});

        var signature = crypto.createHmac('sha512', this._secret)
                              .update(comb)
                              .digest('hex')
                              .toString()
                              .toLowerCase();

        return {url: url.resolve(this._pullUrl, uri),
                method: "GET",
                headers: {"X-Signature": signature},
                qs: {nonce: nonce.toString(), apikey: this._apiKey}};
    };

    private static convertCurrency(code : string) : Currency {
        switch (code) {
            case "USD": return Currency.USD;
            case "BTC": return Currency.BTC;
            case "LTC": return Currency.LTC;
            default: return null;
        }
    }

    private onTick = () => {
        request.get(
            this.getAuth("/api/1/trading/balance"),
            (err, body, resp) => {
                var rpts : Array<HitBtcPositionReport> = JSON.parse(resp).balance;

                if (typeof rpts === 'undefined' || err) {
                    this._log("Trouble getting positions err: %o body: %o", err, body.body);
                    return;
                }

                rpts.forEach(r => {
                    var currency = HitBtcPositionGateway.convertCurrency(r.currency_code);
                    if (currency == null) return;
                    var position = new CurrencyPosition(r.cash, currency);
                    this.PositionUpdate.trigger(position);
                });
            });
    };

    private _apiKey : string;
    private _secret : string;
    private _pullUrl : string;
    constructor(config : Config.IConfigProvider) {
        this._apiKey = config.GetString("HitBtcApiKey");
        this._secret = config.GetString("HitBtcSecret");
        this._pullUrl = config.GetString("HitBtcPullUrl");
        this.onTick();
        setInterval(this.onTick, 15000);
    }
}

class HitBtcBaseGateway implements IExchangeDetailsGateway {
    exchange() : Exchange {
        return Exchange.HitBtc;
    }

    makeFee() : number {
        return -0.0001;
    }

    takeFee() : number {
        return 0.001;
    }

    name() : string {
        return "HitBtc";
    }
}

export class HitBtc extends CombinedGateway {
    constructor(config : Config.IConfigProvider) {
        var orderGateway = config.GetString("HitBtcOrderDestination") == "HitBtc" ?
            <IOrderEntryGateway>new HitBtcOrderEntryGateway(config)
            : new NullOrderGateway();

        // Payment actions are not permitted in demo mode -- helpful.
        var positionGateway = config.environment() == Config.Environment.Dev ?
            new NullPositionGateway() :
            new HitBtcPositionGateway(config);

        super(
            new HitBtcMarketDataGateway(config),
            orderGateway,
            positionGateway,
            new HitBtcBaseGateway());
    }
}