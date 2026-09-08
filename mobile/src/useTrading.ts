import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DemoBroker } from "./demo.ts";
import { createRealBroker, restoreBundledConfiguration } from "./device.ts";
import { TradingError } from "./orderRules.ts";
import type { Account, Broker, Order, Quote, SessionStatus } from "./types.ts";

export function useTrading() {
  const demo = useRef<Broker>(new DemoBroker()).current;
  const realRef = useRef<ReturnType<typeof createRealBroker> | null>(null);
  if (!realRef.current && Platform.OS !== "web")
    realRef.current = createRealBroker();
  const [isDemo, setDemo] = useState(true);
  const broker = isDemo ? demo : realRef.current!;
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0),
    request = useRef(0),
    actionLock = useRef(false);
  const current = useRef({ broker, accountID });
  current.current = { broker, accountID };
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("ths.expo.watchlist.v1"),
      AsyncStorage.getItem("ths.expo.mode.v1"),
      realRef.current ? restoreBundledConfiguration(realRef.current) : Promise.resolve(false),
    ])
      .then(([value, mode, configured]) => {
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
        if ((mode === "real" || (mode === null && configured)) && Platform.OS !== "web") setDemo(false);
      })
      .catch(() => setMessage("恢复连接配置或自选失败，请到连接页重新导入配置。"))
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
    const nextAccounts = await broker.accounts();
    if (!fresh()) return;
    const nextID = nextAccounts.some((a) => a.id === selected)
      ? selected
      : (nextAccounts[0]?.id ?? "");
    setAccounts(nextAccounts);
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
    if (busy || (!demoMode && Platform.OS === "web")) return;
    ++epoch.current;
    setMessage("");
    setDemo(demoMode);
  }
  return {
    broker,
    isDemo,
    switchMode,
    status,
    accounts,
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
