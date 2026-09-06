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
                   quoteTime: nil, isRealtime: false),
        StockQuote(symbol: "MSFT", description: "Microsoft · 演示", lastPrice: 390,
                   bidPrice: 389.98, askPrice: 390.02, netChange: -2, netPercentChange: -0.51,
                   quoteTime: nil, isRealtime: false),
        StockQuote(symbol: "SPY", description: "S&P 500 ETF · 演示", lastPrice: 500,
                   bidPrice: 499.99, askPrice: 500.01, netChange: 0.5, netPercentChange: 0.10,
                   quoteTime: nil, isRealtime: false)
    ]
}
