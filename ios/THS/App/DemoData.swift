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
                   totalVolume: 31_250_000, high52Week: 237.8, low52Week: 164.1,
                   marketCap: 3_000_000_000_000, peRatio: 30.5, sharesOutstanding: 15_000_000_000,
                   averageVolume10Day: 45_000_000),
        StockQuote(symbol: "MSFT", description: "Microsoft · 演示", lastPrice: 390,
                   bidPrice: 389.98, askPrice: 390.02, netChange: -2, netPercentChange: -0.51,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 392.5, highPrice: 394.2, lowPrice: 388.6, closePrice: 392,
                   totalVolume: 18_450_000, high52Week: 468.3, low52Week: 344.7,
                   marketCap: 2_886_000_000_000, peRatio: 32.1, sharesOutstanding: 7_400_000_000,
                   averageVolume10Day: 22_000_000),
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
                   totalVolume: 156_450_000, high52Week: 153.1, low52Week: 75.6,
                   marketCap: 2_940_000_000_000, peRatio: 48.2, sharesOutstanding: 24_500_000_000,
                   averageVolume10Day: 180_000_000),
        StockQuote(symbol: "AMD", description: "AMD · 演示", lastPrice: 160,
                   bidPrice: 159.99, askPrice: 160.01, netChange: 3.5, netPercentChange: 2.24,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 157, highPrice: 161.8, lowPrice: 155.6, closePrice: 156.5,
                   totalVolume: 38_600_000, high52Week: 190.2, low52Week: 95.4,
                   marketCap: 259_200_000_000, peRatio: 42.6, sharesOutstanding: 1_620_000_000,
                   averageVolume10Day: 42_000_000),
        StockQuote(symbol: "TSLA", description: "Tesla · 演示", lastPrice: 250,
                   bidPrice: 249.99, askPrice: 250.01, netChange: -4.2, netPercentChange: -1.65,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 254.7, highPrice: 256.9, lowPrice: 248.4, closePrice: 254.2,
                   totalVolume: 72_400_000, high52Week: 360.5, low52Week: 180.6,
                   marketCap: 800_000_000_000, peRatio: 65.2, sharesOutstanding: 3_200_000_000,
                   averageVolume10Day: 80_000_000),
        StockQuote(symbol: "IWM", description: "Russell 2000 ETF · 演示", lastPrice: 205,
                   bidPrice: 204.99, askPrice: 205.01, netChange: -1.2, netPercentChange: -0.58,
                   quoteTime: nil, isRealtime: false, assetMainType: "EQUITY",
                   openPrice: 206.5, highPrice: 207.1, lowPrice: 203.9, closePrice: 206.2,
                   totalVolume: 21_800_000, high52Week: 230.8, low52Week: 173.2)
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
        let dates = historyDates(range: range, endingAt: end)
        let usesMinuteBars = range.isIntraday || range.minuteInterval != nil
        let rising = (quote.netChange ?? 0) >= 0
        let startingPrice = range == .intraday ? (quote.openPrice ?? price) : price * (rising ? 0.8 : 1.16)
        var previous = startingPrice
        let candles = dates.enumerated().map { index, date -> PriceCandle in
            let progress = Double(index) / Double(dates.count - 1)
            let trend = startingPrice + (price - startingPrice) * progress
            let wave = sin(Double(index) * 0.22) * 0.65 + sin(Double(index) * 0.057) * 0.35
            let amplitude = usesMinuteBars ? 0.007 : 0.08
            let close = index == dates.count - 1 ? price : trend + price * wave * amplitude * sin(.pi * progress)
            let open = usesMinuteBars ? previous : previous * (1 + sin(Double(index) * 1.7) * 0.009)
            let wick = usesMinuteBars ? 0.0005 : 0.003 + abs(sin(Double(index) * 0.8)) * 0.018
            previous = close
            return PriceCandle(time: date, open: open,
                high: max(open, close) * (1 + wick), low: min(open, close) * (1 - wick), close: close,
                volume: Double(100_000 + (index * 7_919) % 300_000) * (usesMinuteBars ? 1 : 100))
        }
        let displayedCandles = range.minuteInterval.map {
            ChartAnalytics.minuteCandles(candles, interval: $0, asOf: end)
        } ?? candles
        return PriceHistory(symbol: symbol, candles: displayedCandles, previousClose: quote.closePrice)
    }

    private static func historyDates(range: HistoryRange, endingAt end: Date) -> [Date] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        var lastDay = calendar.startOfDay(for: end)
        let close = calendar.date(bySettingHour: 16, minute: 0, second: 0, of: lastDay)!
        if close > end { lastDay = calendar.date(byAdding: .day, value: -1, to: lastDay)! }
        while [1, 7].contains(calendar.component(.weekday, from: lastDay)) {
            lastDay = calendar.date(byAdding: .day, value: -1, to: lastDay)!
        }
        if range.isIntraday || range == .daily || range.minuteInterval != nil {
            let sessionCount = range.minuteInterval != nil ? 10 : (range == .fiveDay ? 5 : (range == .daily ? 120 : 1))
            var days: [Date] = []
            var candidate = lastDay
            while days.count < sessionCount {
                if ![1, 7].contains(calendar.component(.weekday, from: candidate)) { days.append(candidate) }
                candidate = calendar.date(byAdding: .day, value: -1, to: candidate)!
            }
            return days.reversed().flatMap { day in
                if range == .daily {
                    return [calendar.date(bySettingHour: 16, minute: 0, second: 0, of: day)!]
                }
                let open = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: day)!
                let step = range == .fiveDay ? 5 : 1
                return stride(from: 0, to: 390, by: step).map { open.addingTimeInterval(Double($0) * 60) }
            }
        }
        let count = range == .weekly ? 104 : 60
        let component: Calendar.Component = range == .weekly ? .weekOfYear : .month
        let anchor = range == .weekly ? lastDay : calendar.date(from: calendar.dateComponents([.year, .month], from: lastDay))!
        return (0..<count).map { index in
            calendar.date(byAdding: component, value: index - count + 1, to: anchor)!
        }
    }
}
