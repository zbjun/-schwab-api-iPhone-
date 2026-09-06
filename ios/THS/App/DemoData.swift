import Foundation

// Fictional examples are used only after the user explicitly selects demo mode.
enum DemoData {
    static let accounts = [BrokerageAccount(
        id: "demo-account", displayNumber: "演示 · 0001", accountType: "演示账户",
        liquidationValue: 12500, cashBalance: 4600, buyingPower: 4600,
        positions: [
            Position(id: "demo-aapl", symbol: "AAPL", description: "Apple · 演示",
                     assetType: "EQUITY", quantity: 20, averagePrice: 190, marketValue: 4000,
                     dayProfitLoss: 30, dayProfitLossPercent: 0.76),
            Position(id: "demo-msft", symbol: "MSFT", description: "Microsoft · 演示",
                     assetType: "EQUITY", quantity: 10, averagePrice: 400, marketValue: 3900,
                     dayProfitLoss: -20, dayProfitLossPercent: -0.51)
        ]
    )]

    static let quotes = [
        StockQuote(symbol: "AAPL", description: "Apple · 演示", lastPrice: 200,
                   bidPrice: 199.99, askPrice: 200.01, netChange: 1.5, netPercentChange: 0.76,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 198.4, highPrice: 201.3, lowPrice: 197.8, closePrice: 198.5,
                   totalVolume: 31_250_000, high52Week: 237.8, low52Week: 164.1),
        StockQuote(symbol: "MSFT", description: "Microsoft · 演示", lastPrice: 390,
                   bidPrice: 389.98, askPrice: 390.02, netChange: -2, netPercentChange: -0.51,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 392.5, highPrice: 394.2, lowPrice: 388.6, closePrice: 392,
                   totalVolume: 18_450_000, high52Week: 468.3, low52Week: 344.7),
        StockQuote(symbol: "SPY", description: "S&P 500 ETF · 演示", lastPrice: 500,
                   bidPrice: 499.99, askPrice: 500.01, netChange: 0.5, netPercentChange: 0.10,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 499.1, highPrice: 501.4, lowPrice: 498.2, closePrice: 499.5,
                   totalVolume: 45_860_000, high52Week: 548.6, low52Week: 412.3),
        StockQuote(symbol: "QQQ", description: "NASDAQ 100 ETF · 演示", lastPrice: 440,
                   bidPrice: 439.98, askPrice: 440.02, netChange: 2.4, netPercentChange: 0.55,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 438.2, highPrice: 442.1, lowPrice: 437.1, closePrice: 437.6,
                   totalVolume: 20_680_000, high52Week: 503.5, low52Week: 365.8),
        StockQuote(symbol: "NVDA", description: "NVIDIA · 演示", lastPrice: 120,
                   bidPrice: 119.99, askPrice: 120.01, netChange: 1.2, netPercentChange: 1.01,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 118.6, highPrice: 122.1, lowPrice: 117.8, closePrice: 118.8,
                   totalVolume: 156_450_000, high52Week: 153.1, low52Week: 75.6)
    ]

    static func quote(symbol: String) -> StockQuote? {
        quotes.first { $0.symbol == symbol }
    }

    static var orders: [BrokerageOrder] {
        let date = Date()
        return [
            BrokerageOrder(id: "910001", status: "WORKING", symbol: "AAPL", side: .buy, kind: .limit,
                quantity: 2, filledQuantity: 0, remainingQuantity: 2, limitPrice: 195, stopPrice: nil,
                duration: .day, enteredAt: date.addingTimeInterval(-1_200), closedAt: nil,
                cancelable: true, editable: true, assetType: "EQUITY", isSimpleEquity: true),
            BrokerageOrder(id: "910002", status: "FILLED", symbol: "SPY", side: .sell, kind: .limit,
                quantity: 5, filledQuantity: 5, remainingQuantity: 0, limitPrice: 498, stopPrice: nil,
                duration: .day, enteredAt: date.addingTimeInterval(-86_400), closedAt: date.addingTimeInterval(-85_200),
                cancelable: false, editable: false, assetType: "EQUITY", isSimpleEquity: true)
        ]
    }

    static func makeOrder(draft: OrderDraft, at date: Date) -> BrokerageOrder {
        BrokerageOrder(id: "demo-\(UUID().uuidString.prefix(8))", status: "WORKING", symbol: draft.symbol,
            side: draft.side, kind: draft.kind, quantity: Double(draft.quantity), filledQuantity: 0,
            remainingQuantity: Double(draft.quantity), limitPrice: draft.limitPrice.map { NSDecimalNumber(decimal: $0).doubleValue },
            stopPrice: draft.stopPrice.map { NSDecimalNumber(decimal: $0).doubleValue }, duration: draft.duration,
            enteredAt: date, closedAt: nil, cancelable: true, editable: true, assetType: "EQUITY", isSimpleEquity: true)
    }

    static func changingStatus(_ order: BrokerageOrder, to status: String, at date: Date) -> BrokerageOrder {
        BrokerageOrder(id: order.id, status: status, symbol: order.symbol, side: order.side, kind: order.kind,
            quantity: order.quantity, filledQuantity: order.filledQuantity, remainingQuantity: order.remainingQuantity,
            limitPrice: order.limitPrice, stopPrice: order.stopPrice, duration: order.duration,
            enteredAt: order.enteredAt, closedAt: date, cancelable: false, editable: false,
            assetType: order.assetType, isSimpleEquity: order.isSimpleEquity)
    }

    static func history(symbol: String, range: HistoryRange, endingAt end: Date) throws -> PriceHistory {
        guard let quote = quote(symbol: symbol), let price = quote.lastPrice else {
            throw TradingWorkflowError.message("当前代码没有演示走势图。")
        }
        let count: Int
        let interval: TimeInterval
        switch range {
        case .day: count = 79; interval = 300
        case .week: count = 65; interval = 1_800
        case .month: count = 23; interval = 86_400
        case .year: count = 252; interval = 86_400
        }
        let candles = (0..<count).map { index -> PriceCandle in
            let progress = Double(index) / Double(count - 1)
            let wave = sin(Double(index) * 0.47) * 0.003 + cos(Double(index) * 0.21) * 0.002
            let close = price * (0.98 + progress * 0.02 + wave)
            let open = close * (1 + sin(Double(index)) * 0.001)
            return PriceCandle(time: end.addingTimeInterval(-Double(count - 1 - index) * interval),
                open: open, high: max(open, close) * 1.001, low: min(open, close) * 0.999,
                close: close, volume: Double(100_000 + (index * 7_919) % 300_000))
        }
        return PriceHistory(symbol: symbol, candles: candles, previousClose: quote.closePrice)
    }
}
