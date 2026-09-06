import Foundation

extension AppStore {
    func prepareOrder(_ draft: OrderDraft) async -> Bool {
        guard !isBusy, !isSubmittingOrder else { return false }
        isSubmittingOrder = true
        defer { isSubmittingOrder = false }
        preparedOrder = nil
        tradeError = nil
        tradeNotice = nil
        let context = generation
        do {
            try draft.validate()
            try requireTradingContext()
            guard let selected = selectedAccount, selectedAccountID == selected.id else {
                throw TradingWorkflowError.message("请先选择交易账户。")
            }
            let account: BrokerageAccount
            let quote: StockQuote
            let hash: String
            if isDemo {
                account = selected
                quote = try await lookupQuote(draft.symbol)
                hash = "demo-account"
            } else {
                async let latestAccounts = client.fetchAccounts()
                async let latestQuote = client.fetchQuotes(symbols: [draft.symbol])
                let (accountResponse, quoteResponse) = try await (latestAccounts, latestQuote)
                guard context == generation, !isDemo,
                      let fresh = accountResponse.value.first(where: { $0.id == selected.id }),
                      let freshQuote = quoteResponse.value.first(where: { $0.symbol == draft.symbol }) else {
                    throw SchwabClientError.sessionChanged
                }
                account = fresh
                quote = freshQuote
                hash = try await accountHash(for: selected.id)
                accounts = accountResponse.value
                accountsUpdatedAt = now()
                accountsLatencyMilliseconds = accountResponse.elapsedMilliseconds
            }
            guard context == generation, selectedAccountID == account.id else { throw SchwabClientError.sessionChanged }
            guard quote.assetMainType?.uppercased() == "EQUITY" else {
                throw TradingWorkflowError.message("当前仅支持已确认类型的股票和 ETF，请核对证券代码。")
            }
            let shares = account.positions.filter { $0.symbol == draft.symbol && $0.assetType == "EQUITY" }
                .reduce(0) { $0 + max(0, $1.quantity) }
            guard draft.side != .sell || Double(draft.quantity) <= shares else {
                throw TradingWorkflowError.message("卖出数量超过当前持仓。此版本仅支持卖出持有的整股。")
            }
            if let replacement = tradeReplacement {
                let latest = try await orderDetail(replacement.id)
                try validateReplacement(latest, draft: draft)
            }
            guard context == generation else { throw SchwabClientError.sessionChanged }
            let price: Double?
            if let limit = draft.limitPrice { price = NSDecimalNumber(decimal: limit).doubleValue }
            else if draft.kind == .stop { price = draft.stopPrice.map { NSDecimalNumber(decimal: $0).doubleValue } }
            else { price = draft.side == .buy ? (quote.askPrice ?? quote.lastPrice) : (quote.bidPrice ?? quote.lastPrice) }
            let estimate = price.flatMap { unit -> Double? in
                let amount = unit * Double(draft.quantity)
                return unit > 0 && amount.isFinite ? amount : nil
            }
            preparedOrder = PreparedOrder(id: UUID(), draft: draft, accountID: account.id,
                accountDisplay: account.displayNumber, accountHash: hash, quote: quote,
                estimatedValue: estimate, availableShares: shares, buyingPower: account.buyingPower,
                preparedAt: now(), replacementOrderID: tradeReplacement?.id, isDemo: isDemo)
            return true
        } catch {
            if !isDemo { await synchronizeTradingAuthentication() }
            tradeError = Self.message(for: error)
            return false
        }
    }

    func submitPreparedOrder() async -> Bool {
        guard !isSubmittingOrder, !isBusy, let prepared = preparedOrder else { return false }
        isSubmittingOrder = true
        defer { isSubmittingOrder = false }
        // Consume the immutable review before any await, so a second tap cannot resend it.
        preparedOrder = nil
        tradeError = nil
        var markerWritten = false
        do {
            try requireTradingContext()
            guard prepared.accountID == selectedAccountID, prepared.isDemo == isDemo,
                  (0...120).contains(now().timeIntervalSince(prepared.preparedAt)) else {
                throw TradingWorkflowError.message("账户或订单核对已变化，请重新核对订单。")
            }
            let context = generation
            if let originalID = prepared.replacementOrderID {
                let latest = try await orderDetail(originalID)
                try validateReplacement(latest, draft: prepared.draft)
            }
            guard context == generation else { throw SchwabClientError.sessionChanged }
            if isDemo {
                let order = DemoData.makeOrder(draft: prepared.draft, at: now())
                if let originalID = prepared.replacementOrderID {
                    demoOrders = demoOrders.map { $0.id == originalID ? DemoData.changingStatus($0, to: "REPLACED", at: now()) : $0 }
                }
                demoOrders.insert(order, at: 0)
                orders = demoOrders
                ordersUpdatedAt = now()
                tradeNotice = "演示订单已创建，未发送到券商。"
            } else {
                try writeOperationMarker()
                markerWritten = true
                let receipt: OrderReceipt
                if let originalID = prepared.replacementOrderID {
                    receipt = try await client.replaceOrder(accountHash: prepared.accountHash, orderID: originalID, draft: prepared.draft)
                } else {
                    receipt = try await client.placeOrder(accountHash: prepared.accountHash, draft: prepared.draft)
                }
                if let id = receipt.orderID {
                    tradeNotice = "券商已接收订单 #\(id)。成交与否请以订单状态为准。"
                    try clearOperationMarker()
                } else {
                    tradeNotice = "券商已接收请求，但未返回可核对的订单编号。请先核对券商订单，再进行新的操作。"
                }
            }
            tradeReplacement = nil
            tradeFormID = UUID()
            activeTab = .orders
            await refreshOrders()
            return true
        } catch {
            if markerWritten, Self.isDefinitiveRejection(error) {
                do { try clearOperationMarker() } catch { /* Keep unresolved if storage cannot be updated. */ }
            }
            if !isDemo { await synchronizeTradingAuthentication() }
            tradeError = markerWritten && unresolvedOrderOperation
                ? "订单操作结果尚未确认，请先核对券商订单，避免重复提交。"
                : Self.message(for: error)
            return false
        }
    }

    func cancelOrder(_ order: BrokerageOrder) async -> Bool {
        guard !isSubmittingOrder, !isBusy else { return false }
        isSubmittingOrder = true
        defer { isSubmittingOrder = false }
        preparedOrder = nil
        tradeError = nil
        tradeNotice = nil
        var markerWritten = false
        let context = generation
        do {
            try requireTradingContext()
            guard order.cancelable, order.isSimpleEquity else { throw TradingWorkflowError.message("这笔订单当前不支持撤单。") }
            let latest = try await orderDetail(order.id)
            guard context == generation, latest.cancelable, latest.isSimpleEquity, latest.isOpen else {
                throw TradingWorkflowError.message("订单状态已变化，请刷新后重新查看。")
            }
            if isDemo {
                demoOrders = demoOrders.map { $0.id == order.id ? DemoData.changingStatus($0, to: "CANCELED", at: now()) : $0 }
                orders = demoOrders
                tradeNotice = "演示订单已撤销，未发送到券商。"
            } else {
                guard let account = selectedAccount else { throw SchwabClientError.sessionChanged }
                let hash = try await accountHash(for: account.id)
                try writeOperationMarker()
                markerWritten = true
                _ = try await client.cancelOrder(accountHash: hash, orderID: order.id)
                try clearOperationMarker()
                tradeNotice = "撤单请求已送达，最终状态请以券商订单为准。"
            }
            await refreshOrders()
            return true
        } catch {
            if markerWritten, Self.isDefinitiveRejection(error) {
                do { try clearOperationMarker() } catch { /* Keep unresolved if storage cannot be updated. */ }
            }
            if !isDemo { await synchronizeTradingAuthentication() }
            tradeError = markerWritten && unresolvedOrderOperation
                ? "撤单结果尚未确认，请先核对券商订单。"
                : Self.message(for: error)
            return false
        }
    }

    func selectAccount(_ id: String) async {
        guard !isBusy, !isSubmittingOrder, accounts.contains(where: { $0.id == id }) else { return }
        guard selectedAccountID != id else { return }
        generation += 1
        selectedAccountID = id
        clearOrderContext()
        await refreshOrders()
    }

    func openTrade(symbol: String, side: OrderSide) {
        guard !isSubmittingOrder else { return }
        resetTradeForm()
        tradeSymbol = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        tradeSide = side
        activeTab = .trade
    }

    func beginReplacement(_ order: BrokerageOrder) {
        guard !isSubmittingOrder, order.editable, order.isSimpleEquity,
              order.isOpen, order.filledQuantity == 0, let side = order.side else { return }
        resetTradeForm()
        tradeReplacement = order
        tradeSymbol = order.symbol
        tradeSide = side
        activeTab = .trade
    }

    func clearTradePreparation() {
        guard !isSubmittingOrder else { return }
        preparedOrder = nil
        tradeError = nil
    }

    func lookupQuote(_ value: String) async throws -> StockQuote {
        let symbol = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Self.validSymbol(symbol) else { throw TradingWorkflowError.message("请输入有效的股票或 ETF 代码。") }
        if isDemo {
            guard let quote = DemoData.quote(symbol: symbol) else {
                throw TradingWorkflowError.message("演示可查看 AAPL、MSFT、SPY、QQQ 和 NVDA。")
            }
            return quote
        }
        let context = generation
        guard isAuthenticated else { throw SchwabClientError.authorizationRequired }
        let response = try await client.fetchQuotes(symbols: [symbol])
        guard context == generation, !isDemo else { throw SchwabClientError.sessionChanged }
        guard let quote = response.value.first(where: { $0.symbol == symbol }) else {
            throw TradingWorkflowError.message("没有找到这个股票代码的报价。")
        }
        return quote
    }

    func priceHistory(symbol value: String, range: HistoryRange) async throws -> PriceHistory {
        let symbol = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Self.validSymbol(symbol) else { throw TradingWorkflowError.message("请输入有效的股票或 ETF 代码。") }
        if isDemo { return try DemoData.history(symbol: symbol, range: range, endingAt: now()) }
        let context = generation
        guard isAuthenticated else { throw SchwabClientError.authorizationRequired }
        let response = try await client.fetchPriceHistory(symbol: symbol, range: range)
        guard context == generation, !isDemo else { throw SchwabClientError.sessionChanged }
        return response.value
    }

    func refreshOrders() async {
        guard !isLoadingOrders else { return }
        guard isDemo || isAuthenticated, let account = selectedAccount else { return }
        isLoadingOrders = true
        let context = generation
        defer { if context == generation { isLoadingOrders = false } }
        ordersError = nil
        if isDemo {
            orders = demoOrders
            ordersUpdatedAt = now()
            return
        }
        do {
            let hash = try await accountHash(for: account.id)
            let end = now()
            let response = try await client.fetchOrders(accountHash: hash,
                from: end.addingTimeInterval(-30 * 86_400), to: end)
            guard context == generation, account.id == selectedAccount?.id, !isDemo else { return }
            orders = response.value.sorted { ($0.enteredAt ?? .distantPast) > ($1.enteredAt ?? .distantPast) }
            ordersUpdatedAt = now()
        } catch {
            guard context == generation else { return }
            await synchronizeTradingAuthentication()
            ordersError = Self.message(for: error)
        }
    }

    func orderDetail(_ id: String) async throws -> BrokerageOrder {
        if isDemo {
            guard let order = demoOrders.first(where: { $0.id == id }) else {
                throw TradingWorkflowError.message("没有找到这笔演示订单。")
            }
            return order
        }
        let context = generation
        guard isAuthenticated, let account = selectedAccount else { throw SchwabClientError.authorizationRequired }
        let hash = try await accountHash(for: account.id)
        let response = try await client.fetchOrder(accountHash: hash, orderID: id)
        guard context == generation, selectedAccount?.id == account.id, !isDemo else { throw SchwabClientError.sessionChanged }
        return response.value
    }

    func acknowledgeOrderReconciliation() {
        guard !isSubmittingOrder, !isDemo else { return }
        do {
            try clearOperationMarker()
            tradeError = nil
            tradeNotice = "已确认你完成券商订单核对，可以重新创建订单。"
            preparedOrder = nil
        } catch { tradeError = "无法清除本机核对记录，请解锁设备后重试。" }
    }

    func clearOrderContext() {
        accountHashes = [:]
        isLoadingOrders = false
        orders = []
        ordersUpdatedAt = nil
        ordersError = nil
        resetTradeForm()
    }

    private func resetTradeForm() {
        preparedOrder = nil
        tradeReplacement = nil
        tradeFormID = UUID()
        tradeError = nil
        tradeNotice = nil
    }

    private func requireTradingContext() throws {
        guard isDemo || isAuthenticated else { throw SchwabClientError.authorizationRequired }
        guard let account = selectedAccount, account.id == selectedAccountID else {
            throw TradingWorkflowError.message("请重新选择交易账户。")
        }
        guard isDemo || !unresolvedOrderOperation else {
            throw TradingWorkflowError.message("有一笔订单操作尚未核对，请先查看券商订单并完成核对。")
        }
    }

    private func validateReplacement(_ order: BrokerageOrder, draft: OrderDraft) throws {
        guard order.editable, order.isSimpleEquity, order.isOpen, order.filledQuantity == 0,
              order.symbol == draft.symbol, order.side == draft.side else {
            throw TradingWorkflowError.message("订单已成交、状态已变化，或证券/方向不一致，不能按当前草稿改单。")
        }
    }

    private func accountHash(for accountID: String) async throws -> String {
        if let hash = accountHashes[accountID] { return hash }
        let context = generation
        let response = try await client.fetchAccountIdentifiers()
        guard context == generation, !isDemo else { throw SchwabClientError.sessionChanged }
        var hashes: [String: String] = [:]
        for item in response.value {
            guard hashes[item.accountNumber] == nil else { throw SchwabClientError.invalidResponse }
            hashes[item.accountNumber] = item.hashValue
        }
        accountHashes = hashes
        guard let hash = hashes[accountID] else { throw TradingWorkflowError.message("当前账户尚未取得交易标识，请重新授权这个账户。") }
        return hash
    }

    private func writeOperationMarker() throws {
        do { try operationStore.write(Data("pending:\(UUID().uuidString):\(now().timeIntervalSince1970)".utf8)) }
        catch { throw SchwabClientError.secureStorage }
        unresolvedOrderOperation = true
    }

    private func clearOperationMarker() throws {
        do { try operationStore.clear() }
        catch { throw SchwabClientError.secureStorage }
        unresolvedOrderOperation = false
    }

    private static func isDefinitiveRejection(_ error: Error) -> Bool {
        guard let error = error as? SchwabClientError else { return false }
        switch error {
        case .httpStatus(let status): return (400..<500).contains(status) && status != 408
        case .credentialsRequired, .invalidCredentials, .authorizationRequired, .authorizationExpired,
             .invalidSymbols, .invalidTradingAccount, .invalidOrderIdentifier, .invalidDateRange: return true
        default: return false
        }
    }

    private func synchronizeTradingAuthentication() async {
        let context = generation
        guard let status = try? await client.sessionStatus(), context == generation else { return }
        isConfigured = status.configured
        isAuthenticated = status.authenticated
        if !status.authenticated, !isDemo {
            generation += 1
            clearFinancialData()
            statusMessage = nil
        }
    }
}
