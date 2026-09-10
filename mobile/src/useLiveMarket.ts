import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Broker, Candle, History, HistoryRange, Quote } from "./types.ts";
import { mergeFormingCandle, mergeObservedCandle, pruneObservedCandles, overlayLiveHistory } from "./liveHistory.ts";
import { volumeRatio } from "./marketStatistics.ts";
import { marketRefreshInterval, shareHistory } from "./marketRefresh.ts";
import { startMarketPolling } from "./marketPolling.ts";

export function useLiveMarket(
  broker: Broker,
  symbol: string,
  range: HistoryRange,
  revision: number,
  demo: boolean,
  authenticated: boolean,
) {
  const [history, setHistory] = useState<History>();
  const [quote, setQuote] = useState<Quote>();
  const [ratio, setRatio] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [streamStatus, setStreamStatus] = useState<
    "connecting" | "live" | "fallback" | "off"
  >("off");
  const streamStatusRef = useRef(streamStatus);
  const [streamQuote, setStreamQuote] = useState<Partial<Quote>>();
  const [observations, setObservations] = useState<{ broker: Broker; symbol: string; candles: Candle[] }>(
    () => ({ broker, symbol, candles: [] }),
  );
  const streamMinutes = observations.broker === broker && observations.symbol === symbol
    ? observations.candles : [];
  const retainCandle = (candle: Candle, forming: boolean) => {
    setObservations((previous) => {
      const sameSource = previous.broker === broker && previous.symbol === symbol;
      const before = sameSource ? previous.candles : [];
      const candles = (forming ? mergeFormingCandle : mergeObservedCandle)(before, candle, Date.now());
      return sameSource && candles === before ? previous : { broker, symbol, candles };
    });
  };
  const [foreground, setForeground] = useState(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) =>
      setForeground(value === "active"),
    );
    return () => listener.remove();
  }, []);
  const active = foreground && authenticated;
  const activeRef = useRef(active);
  activeRef.current = active;
  const polls = useRef(new Set<ReturnType<typeof startMarketPolling>>());
  useEffect(() => {
    for (const poll of polls.current) poll.setActive(active);
  }, [active]);

  useEffect(() => {
    setObservations((previous) => {
      if (previous.broker !== broker || previous.symbol !== symbol)
        return { broker, symbol, candles: [] };
      const candles = pruneObservedCandles(previous.candles, Date.now());
      return candles === previous.candles ? previous : { ...previous, candles };
    });
  }, [active, broker, symbol]);

  useEffect(() => {
    setStreamQuote(undefined);
    // Foreground changes and reconnects retain observations for this source.
    // A different broker/symbol is never rendered with the previous buffer.
    streamStatusRef.current = "off";
    setStreamStatus("off");
    if (!active || demo || !broker.subscribeMarket) return;
    let mounted = true;
    const stop = broker.subscribeMarket(symbol, {
      onStatus: (status) => {
        if (!mounted) return;
        const previous = streamStatusRef.current;
        streamStatusRef.current = status;
        setStreamStatus(status);
        if (status === "fallback" && previous !== "fallback") {
          setStreamQuote(undefined);

          for (const poll of polls.current) {
            poll.setActive(false);
            poll.setActive(activeRef.current);
          }
        }
      },
      onQuote: (next) => {
        if (!mounted) return;
        setQuoteError("");
        setStreamQuote(next);
      },
      onFormingCandle: (candle) => {
        if (mounted) retainCandle(candle, true);
      },
      onCandle: (candle) => {
        if (mounted) retainCandle(candle, false);
      },
    });
    return () => {
      mounted = false;
      stop();
      streamStatusRef.current = "off";
    };
  }, [active, demo, broker, symbol]);

  // Simultaneous chart and volume-ratio reads share the same history request.
  const readHistory = useMemo(() => {
    const pending = new Map<HistoryRange, Promise<History>>();
    return (period: HistoryRange) => {
      const existing = pending.get(period);
      if (existing) return existing;
      const request = broker
        .history(symbol, period)
        .finally(() => pending.delete(period));
      pending.set(period, request);
      return request;
    };
  }, [broker, symbol]);

  useEffect(() => {
    setHistory(undefined);
    setLoading(true);
    setHistoryError("");
  }, [broker, symbol, range]);
  useEffect(() => {
    setQuote(undefined);
    setQuoteError("");
    setRatio(undefined);
  }, [broker, symbol]);

  useEffect(() => {
    let mounted = true;
    const poll = startMarketPolling({
      interval: () =>
        streamStatusRef.current === "live"
          ? 60_000
          : marketRefreshInterval("history", range, Date.now(), demo),
      run: async () => {
        try {
          const next = await readHistory(range);
          if (mounted) {
            setHistory((prev) => shareHistory(prev, next));
            setHistoryError("");
          }
        } finally {
          if (mounted) setLoading(false);
        }
      },
      onError: () => {
        if (mounted) setHistoryError("K线刷新失败，保留上次数据，正在重试。");
      },
    });
    polls.current.add(poll);
    poll.setActive(activeRef.current);
    return () => {
      mounted = false;
      poll.stop();
      polls.current.delete(poll);
    };
  }, [readHistory, range, revision, demo]);

  useEffect(() => {
    let mounted = true,
      metadataAt = -Infinity;
    const poll = startMarketPolling({
      interval: () =>
        streamStatusRef.current === "live"
          ? 60_000
          : marketRefreshInterval("quote", "intraday", Date.now(), demo),
      run: async () => {
        const fundamentals = Date.now() - metadataAt >= 30 * 60_000;
        if (streamStatusRef.current === "live" && !fundamentals) return;
        const [next] = await broker.quotes([symbol], { fundamentals });
        if (!next) throw new Error("Quote unavailable");
        if (mounted) {
          if (fundamentals) metadataAt = Date.now();
          setQuote((prev) => ({
            ...next,
            marketCap: next.marketCap ?? prev?.marketCap,
            sharesOutstanding:
              next.sharesOutstanding ?? prev?.sharesOutstanding,
            peRatio: next.peRatio ?? prev?.peRatio,
          }));
          setQuoteError("");
        }
      },
      onError: () => {
        if (mounted) setQuoteError("报价刷新失败，保留上次数据，正在重试。");
      },
    });
    polls.current.add(poll);
    poll.setActive(activeRef.current);
    return () => {
      mounted = false;
      poll.stop();
      polls.current.delete(poll);
    };
    // Quote cadence does not depend on chart period; keep the same poller when switching K ranges.
  }, [broker, symbol, revision, demo]);

  useEffect(() => {
    let mounted = true;
    const poll = startMarketPolling({
      interval: () => 60_000,
      run: async () => {
        const [intraday, daily] = await Promise.all([
          readHistory("intraday"),
          readHistory("daily"),
        ]);
        if (mounted) setRatio(volumeRatio(intraday, daily));
      },
    });
    polls.current.add(poll);
    poll.setActive(activeRef.current);
    return () => {
      mounted = false;
      poll.stop();
      polls.current.delete(poll);
    };
  }, [readHistory, revision]);
  const liveTrade = useMemo(
    () =>
      streamQuote
        ? {
            symbol,
            lastPrice: streamQuote.lastPrice,
            tradeTime: streamQuote.tradeTime,
            isRealtime: streamQuote.isRealtime,
          }
        : undefined,
    [
      symbol,
      streamQuote?.lastPrice,
      streamQuote?.tradeTime,
      streamQuote?.isRealtime,
    ],
  );
  const chartHistory = useMemo(
    () =>
      overlayLiveHistory(history, range, streamMinutes, liveTrade, Date.now()),
    [history, range, streamMinutes, liveTrade],
  );
  const latestQuote = useMemo(() => {
    if (!streamQuote || streamStatus !== "live") return quote;
    if (
      Math.max(streamQuote.quoteTime ?? 0, streamQuote.tradeTime ?? 0) <
      Math.max(quote?.quoteTime ?? 0, quote?.tradeTime ?? 0)
    )
      return quote;
    return { ...quote, ...streamQuote, symbol };
  }, [quote, streamQuote, streamStatus, symbol]);
  return {
    history: chartHistory,
    quote: latestQuote,
    streamStatus,
    provisional: chartHistory?.candles.some((c) => c.provisional) ?? false,
    ratio,
    loading,
    error: [historyError, quoteError].filter(Boolean).join(" "),
  };
}
