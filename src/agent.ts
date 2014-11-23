/// <reference path="models.ts" />
/// <reference path="config.ts" />

import Config = require("config");

export class PositionAggregator {
    PositionUpdate = new Evt<ExchangeCurrencyPosition>();

    constructor(private _brokers : Array<IBroker>) {
        this._brokers.forEach(b => {
            b.PositionUpdate.on(m => this.PositionUpdate.trigger(m));
        });
    }
}

export class MarketDataAggregator {
    MarketData = new Evt<Market>();

    constructor(private _brokers : Array<IBroker>) {
        this._brokers.forEach(b => {
            b.MarketData.on(m => this.MarketData.trigger(m));
        });
    }
}

export class OrderBrokerAggregator {
    _log : Logger = log("tribeca:brokeraggregator");
    _brokersByExch : { [exchange: number]: IBroker} = {};

    OrderUpdate : Evt<OrderStatusReport> = new Evt<OrderStatusReport>();

    constructor(private _brokers : Array<IBroker>) {

        this._brokers.forEach(b => {
            b.OrderUpdate.on(o => this.OrderUpdate.trigger(o));
        });

        for (var i = 0; i < this._brokers.length; i++)
            this._brokersByExch[this._brokers[i].exchange()] = this._brokers[i];
    }

    public submitOrder = (o : SubmitNewOrder) => {
        try {
            this._brokersByExch[o.exchange].sendOrder(o);
        }
        catch (e) {
            this._log("Exception while sending order", o, e, e.stack);
        }
    };

    public cancelReplaceOrder = (o : CancelReplaceOrder) => {
        try {
            this._brokersByExch[o.exchange].replaceOrder(o);
        }
        catch (e) {
            this._log("Exception while cancel/replacing order", o, e, e.stack);
        }
    };

    public cancelOrder = (o : OrderCancel) => {
        try {
            this._brokersByExch[o.exchange].cancelOrder(o);
        }
        catch (e) {
            this._log("Exception while cancelling order", o, e, e.stack);
        }
    };
}

export class Agent {
    private _log : Logger = log("tribeca:agent");
    private _maxSize : number;
    private _minProfit : number;

    constructor(private _brokers : Array<IBroker>,
                private _mdAgg : MarketDataAggregator,
                private _orderAgg : OrderBrokerAggregator,
                private config : Config.IConfigProvider) {
        this._maxSize = config.GetNumber("MaxSize");
        this._minProfit = config.GetNumber("MinProfit");
        _mdAgg.MarketData.on(m => this.recalcMarkets(m.update.time));
    }

    Active : boolean = false;
    ActiveChanged = new Evt<boolean>();

    LastBestResult : Result = null;
    BestResultChanged = new Evt<Result>();

    private _activeOrderIds : { [ exch : number] : string} = {};

    changeActiveStatus = (to : boolean) => {
        if (this.Active != to) {
            this.Active = to;

            if (this.Active) {
                this.recalcMarkets(date());
            }
            else if (!this.Active && this.LastBestResult != null) {
                this.stop(this.LastBestResult, true, date());
            }

            this._log("changing active status to %o", to);
            this.ActiveChanged.trigger(to);
        }
    };

    private static isBrokerActive(b : IBroker) : boolean {
        return b.currentBook != null && b.connectStatus == ConnectivityStatus.Connected;
    }

    private recalcMarkets = (generatedTime : Moment) => {
        var bestResult : Result = null;
        var bestProfit: number = Number.MIN_VALUE;

        for (var i = 0; i < this._brokers.length; i++) {
            var restBroker = this._brokers[i];
            if (!Agent.isBrokerActive(restBroker)) continue;
            var restTop = restBroker.currentBook.update;

            for (var j = 0; j < this._brokers.length; j++) {
                var hideBroker = this._brokers[j];
                if (i == j || !Agent.isBrokerActive(hideBroker)) continue;

                var hideTop = hideBroker.currentBook.update;

                var bidSize = Math.min(this._maxSize, hideTop.bid.size);
                var pBid = bidSize * (-(1 + restBroker.makeFee()) * restTop.bid.price + (1 + hideBroker.takeFee()) * hideTop.bid.price);

                var askSize = Math.min(this._maxSize, hideTop.ask.size);
                var pAsk = askSize * (+(1 + restBroker.makeFee()) * restTop.ask.price - (1 + hideBroker.takeFee()) * hideTop.ask.price);

                if (pBid > bestProfit && pBid > this._minProfit && bidSize >= .01) {
                    bestProfit = pBid;
                    bestResult = new Result(Side.Bid, restBroker, hideBroker, pBid, restTop.bid, hideTop.bid, bidSize, generatedTime);
                }

                if (pAsk > bestProfit && pAsk > this._minProfit && askSize >= .01) {
                    bestProfit = pAsk;
                    bestResult = new Result(Side.Ask, restBroker, hideBroker, pAsk, restTop.ask, hideTop.ask, askSize, generatedTime);
                }
            }
        }

        // do this async, off this event cycle
        setTimeout(() => this.BestResultChanged.trigger(bestResult), 0);

        if (!this.Active)
            return;

        // TODO: think about sizing, currently doing 0.025 BTC - risk mitigation
        // TODO: some sort of account limits interface
        if (bestResult == null && this.LastBestResult !== null) {
            this.stop(this.LastBestResult, true, generatedTime);
        }
        else if (bestResult !== null && this.LastBestResult == null) {
            this.start(bestResult);
        }
        else if (bestResult !== null && this.LastBestResult !== null) {
            if (bestResult.restBroker.exchange() != this.LastBestResult.restBroker.exchange()
                    || bestResult.restSide != this.LastBestResult.restSide) {
                // don't flicker
                if (Math.abs(bestResult.profit - this.LastBestResult.profit) < this._minProfit) {
                    this.noChange(bestResult);
                }
                else {
                    this.stop(this.LastBestResult, true, generatedTime);
                    this.start(bestResult);
                }
            }
            else if (Math.abs(bestResult.rest.price - this.LastBestResult.rest.price) > 1e-3) {
                this.modify(bestResult);
            }
            else {
                this.noChange(bestResult);
            }
        }
        else {
            this._log("NOTHING");
        }
    };

    private noChange = (r : Result) => {
        this._log("NO CHANGE :: p=%d > %s Rest (%s) %d :: Hide (%s) %d", r.profit, Side[r.restSide],
                r.restBroker.name(), r.rest.price, r.hideBroker.name(), r.hide.price);
    };

    private modify = (r : Result) => {
        var restExch = r.restBroker.exchange();
        // cxl-rpl live order -- need to rethink cxl-rpl
        var cxl = new OrderCancel(this._activeOrderIds[restExch], restExch, r.generatedTime);
        r.restBroker.cancelOrder(cxl);
        var newOrder = new SubmitNewOrder(r.restSide, r.size, OrderType.Limit, r.rest.price, TimeInForce.GTC, restExch, r.generatedTime);
        this._activeOrderIds[restExch] = r.restBroker.sendOrder(newOrder).sentOrderClientId;

        this._log("MODIFY :: p=%d > %s Rest (%s) %d :: Hide (%s) %d", r.profit, Side[r.restSide],
            r.restBroker.name(), r.rest.price, r.hideBroker.name(), r.hide.price);

        this.LastBestResult = r;
    };

    private start = (r : Result) => {
        var restExch = r.restBroker.exchange();
        // set up fill notification
        r.restBroker.OrderUpdate.on(this.arbFire);

        // send an order
        var sent = r.restBroker.sendOrder(new SubmitNewOrder(r.restSide, r.size, OrderType.Limit, r.rest.price, TimeInForce.GTC, restExch, r.generatedTime));
        this._activeOrderIds[restExch] = sent.sentOrderClientId;

        this._log("START :: p=%d > %s Rest (%s) %d :: Hide (%s) %d", r.profit, Side[r.restSide],
            r.restBroker.name(), r.rest.price, r.hideBroker.name(), r.hide.price);

        this.LastBestResult = r;
    };

    private stop = (lr : Result, sendCancel : boolean, t : Moment) => {
        // remove fill notification
        lr.restBroker.OrderUpdate.off(this.arbFire);

        // cancel open order
        var restExch = lr.restBroker.exchange();
        if (sendCancel) lr.restBroker.cancelOrder(new OrderCancel(this._activeOrderIds[restExch], restExch, t));
        delete this._activeOrderIds[restExch];

        this._log("STOP :: p=%d > %s Rest (%s) %d :: Hide (%s) %d", lr.profit,
            Side[lr.restSide], lr.restBroker.name(),
            lr.rest.price, lr.hideBroker.name(), lr.hide.price);

        this.LastBestResult = null;
    };

    private arbFire = (o : OrderStatusReport) => {
        if (!(o.lastQuantity > 0))
            return;

        var hideBroker = this.LastBestResult.hideBroker;
        var px = o.side == Side.Ask
            ? hideBroker.currentBook.update.ask.price
            : hideBroker.currentBook.update.bid.price;
        var side = o.side == Side.Bid ? Side.Ask : Side.Bid;
        hideBroker.sendOrder(new SubmitNewOrder(side, o.lastQuantity, o.type, px, TimeInForce.IOC, hideBroker.exchange(), o.time));

        this._log("ARBFIRE :: rested %s %d for %d on %s --> pushing %s %d for %d on %s",
            Side[o.side], o.lastQuantity, o.lastPrice, Exchange[this.LastBestResult.restBroker.exchange()],
            Side[side], o.lastQuantity, px, Exchange[this.LastBestResult.hideBroker.exchange()]);

        this.stop(this.LastBestResult, o.orderStatus != OrderStatus.Complete, o.time);
    };
}