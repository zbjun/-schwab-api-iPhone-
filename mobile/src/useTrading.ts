import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DemoBroker } from "./demo.ts";
import { createRealBroker, createServerBroker, restoreBundledConfiguration, restoreBundledServer } from "./device.ts";
import { TradingError } from "./orderRules.ts";
import type { Account, Broker, Order, Quote, SessionStatus } from "./types.ts";
import { createAccountReader } from "./accountRefresh.ts";
import { startMarketPolling } from "./marketPolling.ts";

export function useTrading() {
  const demo = useRef<Broker>(new DemoBroker()).current;
  const realRef = useRef<ReturnType<typeof createRealBroker> | null>(null);
  const serverRef = useRef<ReturnType<typeof createServerBroker> | null>(null);
  const [transport, setTransport] = useState<"direct" | "server">("direct");
  const [isDemo, setDemo] = useState(true);
  const broker: Broker = isDemo ? demo : transport === "server" ? serverRef.current! : realRef.current!;
  const [status, setStatus] = useState<SessionStatus>({
    configured: false,
    authenticated: false,
    unresolvedOperation: false,
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountID, setAccountID] = useState("");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [watchlist, setWatchlist] = useState([
    "AAPL",
    "NVDA",
    "TSLA",
    "MSFT",
    "AMZN",
    "GOOGL",
    "SPY",
    "QQQ",
  ]);
  const [storageReady, setStorageReady] = useState(false);
  const [quickMode, setQuickMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [accountVisible, setAccountVisible] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const [accountsUpdatedAt, setAccountsUpdatedAt] = useState<number>();
  const [accountRefreshError, setAccountRefreshError] = useState("");
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const accountReader = useRef(createAccountReader<Account[]>()).current;
  const accountGeneration = useRef<object>({});
  const fullRefreshes = useRef(0);
  const pullLock = useRef(false);
  const epoch = useRef(0),
    request = useRef(0),
    actionLock = useRef(false);
  const current = useRef({ broker, accountID });
  current.current = { broker, accountID };
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) => setForeground(value === "active"));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("ths.expo.watchlist.v1"),
      AsyncStorage.getItem("ths.expo.mode.v1"),
      AsyncStorage.getItem("ths.expo.transport.v1"),
      AsyncStorage.getItem("ths.expo.quickMode.v1"),
    ])
      .then(async ([value, mode, savedTransport, quick]) => {
        let configured = false;
        let nextTransport: "server" | "direct" = savedTransport === "server" ? "server" : "direct";
        let importedServer = false;
        if (Platform.OS !== "web") {
          serverRef.current = createServerBroker();
          importedServer = await restoreBundledServer(serverRef.current, async () => {
            await AsyncStorage.setItem("ths.expo.transport.v1", "server");
            await AsyncStorage.setItem("ths.expo.mode.v1", "real");
          });
          if (importedServer) nextTransport = "server";
          if (nextTransport === "direct") {
            realRef.current = createRealBroker();
            configured = await restoreBundledConfiguration(realRef.current);
          }
        }
        setTransport(nextTransport);
        setQuickMode(quick === "true");
        if (value) {
          const list = JSON.parse(value);
          if (
            Array.isArray(list) &&
            list.length <= 50 &&
            list.every(
              (s) =>
                typeof s === "string" && /^[A-Z][A-Z0-9./-]{0,14}$/.test(s),
            )
          )
            setWatchlist([...new Set<string>(list)]);
        }
        if ((importedServer || mode === "real" || (mode === null && configured)) && Platform.OS !== "web") setDemo(false);
      })
      .catch(() => setMessage("恢复偏好或配置失败，请到设置中的连接检查。"))
      .finally(() => setStorageReady(true));
  }, []);
  useEffect(() => {
    if (storageReady)
      void AsyncStorage.setItem(
        "ths.expo.watchlist.v1",
        JSON.stringify(watchlist),
      ).catch(() => setMessage("自选保存失败，请稍后重试。"));
  }, [watchlist, storageReady]);
  useEffect(() => {
    if (storageReady)
      void AsyncStorage.setItem(
        "ths.expo.mode.v1",
        isDemo ? "demo" : "real",
      ).catch(() => setMessage("连接偏好保存失败。"));
  }, [isDemo, storageReady]);
  async function refresh() {
    ++fullRefreshes.current;
    accountGeneration.current = {};
    try {
      await refreshAll();
    } finally {
      --fullRefreshes.current;
    }
  }
  async function refreshAll() {
    const version = epoch.current,
      ticket = ++request.current,
      selected = accountID;
    const fresh = () => version === epoch.current && ticket === request.current;
    setOrdersLoaded(false);
    setOrdersError("");
    const s = await broker.status();
    if (!fresh()) return;
    setStatus(s);
    if (!s.authenticated) {
      setAccounts([]);
      setAccountID("");
      setQuotes({});
      setOrders([]);
      setOrdersLoaded(false);
      return;
    }
    const nextAccounts = await accountReader.read(accountGeneration.current, () => broker.accounts());
    if (!fresh()) return;
    const nextID = nextAccounts.some((a) => a.id === selected)
      ? selected
      : (nextAccounts[0]?.id ?? "");
    setAccounts(nextAccounts);
    setAccountsUpdatedAt(Date.now());
    setAccountRefreshError("");
    setAccountID(nextID);
    if (nextID !== selected) setOrders([]);
    setOrdersLoaded(false);
    const symbols = [
      ...new Set([
        ...watchlist,
        ...nextAccounts.flatMap((a) => a.positions.map((p) => p.symbol)),
      ]),
    ];
    const results = await Promise.allSettled([
      symbols.length ? broker.quotes(symbols) : Promise.resolve([] as Quote[]),
      nextID ? broker.orders(nextID) : Promise.resolve([] as Order[]),
    ]);
    if (!fresh()) return;
    const [q, o] = results;
    if (q.status === "fulfilled")
      setQuotes(
        Object.fromEntries(q.value.map((quote) => [quote.symbol, quote])),
      );
    if (o.status === "fulfilled") {
      setOrders(o.value);
      setOrdersLoaded(true);
    } else {
      setOrdersError(readFailure("订单", o.reason));
    }
    setRevision((value) => value + 1);
    const failures = [
      o.status === "rejected" ? readFailure("订单", o.reason) : "",
      q.status === "rejected" ? readFailure("行情", q.reason) : "",
    ].filter(Boolean);
    if (failures.length) throw new Error(failures.join("\n"));
  }
  async function run(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    // In-flight background account reads cannot apply across a user operation.
    accountGeneration.current = {};
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "操作失败，请稍后重试。",
      );
    } finally {
      try {
        setStatus(await current.current.broker.status());
      } catch {}
      actionLock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const version = ++epoch.current;
    accountGeneration.current = {};
    setAccountsUpdatedAt(undefined);
    setAccountRefreshError("");
    setAccounts([]);
    setAccountID("");
    setQuotes({});
    setOrders([]);
    setOrdersLoaded(false);
    setOrdersError("");
    void refresh().catch((error) => {
      if (epoch.current === version)
        setMessage(error instanceof Error ? error.message : "连接失败。");
    });
  }, [broker]);
  useEffect(() => {
    if (!accountVisible || !foreground || !storageReady || !status.authenticated || !accountID) return;
    let active = true;
    const version = epoch.current;
    const polling = startMarketPolling({
      interval: () => 5000,
      cadence: "completion",
      run: async () => {
        if (actionLock.current || fullRefreshes.current) return;
        const generation = accountGeneration.current;
        const fresh = () => active && !actionLock.current && !fullRefreshes.current &&
          version === epoch.current && generation === accountGeneration.current &&
          broker === current.current.broker && accountID === current.current.accountID;
        try {
          const nextAccounts = await accountReader.read(generation, () => broker.accounts());
          if (!fresh()) return;
          setAccounts(nextAccounts);
          setAccountsUpdatedAt(Date.now());
          setAccountRefreshError("");
        } catch (error) {
          if (fresh()) setAccountRefreshError(readFailure("账户", error));
          throw error;
        }
      },
    });
    polling.setActive(true);
    return () => { active = false; polling.stop(); };
  }, [accountVisible, foreground, storageReady, status.authenticated, broker, accountID]);
  async function pullRefreshAccounts() {
    if (pullLock.current || actionLock.current) return;
    pullLock.current = true;
    setAccountRefreshing(true);
    try { await run(refresh); }
    finally { pullLock.current = false; setAccountRefreshing(false); }
  }
  useEffect(() => {
    if (!status.authenticated) return;
    const version = epoch.current;
    let active = true;
    void broker
      .quotes(watchlist)
      .then((result) => {
        if (active && version === epoch.current)
          setQuotes((prev) => ({
            ...prev,
            ...Object.fromEntries(result.map((q) => [q.symbol, q])),
          }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [watchlist, broker, status.authenticated]);
  function selectAccount(id: string) {
    if (busy || id === accountID) return;
    ++epoch.current;
    accountGeneration.current = {};
    setAccountID(id);
    setOrders([]);
    setOrdersLoaded(false);
    setOrdersError("");
    const version = epoch.current;
    const ticket = ++request.current;
    void broker
      .orders(id)
      .then((values) => {
        if (epoch.current === version && request.current === ticket) {
          setOrders(values);
          setOrdersLoaded(true);
        }
      })
      .catch((error) => {
        if (epoch.current !== version || request.current !== ticket) return;
        const failure = readFailure("订单", error);
        setOrdersError(failure);
        setMessage(failure);
      });
  }
  function switchMode(demoMode: boolean) {
    if (busy || !storageReady || (!demoMode && Platform.OS === "web")) return;
    if (!demoMode) {
      // Preference storage can fail before startup constructs a broker. Do not leave
      // demo mode until the selected native transport is actually available.
      try {
        if (transport === "server") serverRef.current ??= createServerBroker();
        else realRef.current ??= createRealBroker();
      } catch {
        setMessage("初始化设备连接失败，请稍后重试或在设置中检查连接配置。");
        return;
      }
    }
    ++epoch.current;
    setMessage("");
    setDemo(demoMode);
  }
  async function changeTransport(value: "direct" | "server") {
    if (!storageReady || value === transport) return;
    if (Platform.OS === "web") { setTransport(value); return; }
    if (value === "server") serverRef.current ??= createServerBroker();
    else {
      realRef.current ??= createRealBroker();
      await restoreBundledConfiguration(realRef.current);
    }
    await AsyncStorage.setItem("ths.expo.transport.v1", value);
    ++epoch.current;
    setStatus({ configured: false, authenticated: false, unresolvedOperation: false });
    setTransport(value);
  }
  async function changeQuickMode(value: boolean) {
    if (!storageReady) return;
    await AsyncStorage.setItem("ths.expo.quickMode.v1", value ? "true" : "false");
    setQuickMode(value);
  }
  return {
    transport,
    changeTransport,
    serverBroker: serverRef.current,
    quickMode,
    changeQuickMode,
    storageReady,
    broker,
    isDemo,
    switchMode,
    status,
    accounts,
    setAccountVisible,
    accountsUpdatedAt,
    accountRefreshError,
    accountRefreshing,
    pullRefreshAccounts,
    accountID,
    selectAccount,
    account: accounts.find((a) => a.id === accountID),
    quotes,
    orders,
    ordersLoaded,
    ordersError,
    watchlist,
    setWatchlist,
    busy,
    message,
    setMessage,
    refresh,
    run,
    revision,
  };
}
function readFailure(resource: string, reason: unknown): string {
  return `${resource}读取失败：${reason instanceof TradingError ? reason.message : "连接未完成，请刷新重试。"}`;
}
export type TradingState = ReturnType<typeof useTrading>;
