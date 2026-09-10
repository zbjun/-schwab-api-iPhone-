import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  GestureResponderEvent,
  PanResponderGestureState,
} from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { createChartPress } from "./chartPress.ts";
import { latestSessionLocation, sessionViewport } from "./chartSessions.ts";
import { chartDragIntent, chartInteractionActive, type ChartDragIntent } from "./chartGesture.ts";
import FormingCandle from "./FormingCandle.tsx";
import type {
  Candle,
  History,
  HistoryRange,
  Palette,
  TradeExecution,
} from "./types";
import { tradeMarkers } from "./tradeMarkers.ts";
import {
  candlePriceDomain,
  chartSessionWindow,
  createViewport,
  isLineRange,
  minuteInterval,
  movingAverage,
  newYorkDateKey,
  panViewport,
  rangeTitle,
  reconcileViewport,
  sessionAverage,
  sessionTitles,
  validCandle,
  visibleRange,
  zoomViewport,
} from "./chartData";
import type { CandleViewport, TradingSession } from "./chartData";

interface Props {
  history: History;
  range: HistoryRange;
  palette: Palette;
  height?: number;
  compact?: boolean;
  onInspectChange?: (active: boolean) => void;
  onSelectionChange?: (candle: Candle | undefined) => void;
  executions?: TradeExecution[];
  averageCost?: number;
}
interface GestureBaseline {
  mode: "pan" | "pinch";
  viewport: CandleViewport;
  startX: number;
  distance: number;
  anchor: number;
  width: number;
}
interface SessionSegment {
  session: TradingSession;
  day: string;
  first: number;
  end: number;
}
const periods = [5, 10, 20, 30];
const noExecutions: TradeExecution[] = [];
const sessions: TradingSession[] = ["overnight", "premarket", "regular", "postmarket"];
const clamp = (value: number, lower: number, upper: number): number =>
  Math.min(upper, Math.max(lower, value));
const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);
const price = (value: number | undefined): string =>
  finite(value)
    ? value.toLocaleString("en-US", {
        maximumFractionDigits: value < 1 ? 4 : 2,
        minimumFractionDigits: 2,
      })
    : "—";
const volumeText = (value: number | undefined): string =>
  !finite(value) || value < 0
    ? "—"
    : value >= 100_000_000
      ? `${(value / 100_000_000).toFixed(2)}亿`
      : value >= 10_000
        ? `${(value / 10_000).toFixed(2)}万`
        : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "2-digit",
  day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dateTime = (time: number): string =>
  `${dateFormatter.format(time)} ${timeFormatter.format(time)}`;
function isDark(background: string): boolean {
  const hex = background.replace("#", "");
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((value) => value + value)
          .join("")
      : hex;
  if (!/^[a-fA-F0-9]{6}$/.test(expanded)) return false;
  const channels = [0, 2, 4].map((index) =>
    parseInt(expanded.slice(index, index + 2), 16),
  );
  return (
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 128
  );
}

function linePath(
  indices: number[],
  values: (number | undefined)[],
  x: (index: number) => number,
  y: (value: number) => number,
  days?: (string | undefined)[],
): string {
  let drawing = false;
  let previousDay: string | undefined;
  const parts: string[] = [];
  for (const index of indices) {
    const value = values[index];
    if (!finite(value)) {
      drawing = false;
      continue;
    }
    if (days && days[index] !== previousDay) drawing = false;
    parts.push(
      `${drawing ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`,
    );
    drawing = true;
    previousDay = days?.[index];
  }
  return parts.join(" ");
}

function MarketChart({
  history,
  range,
  palette,
  height: requestedHeight,
  compact = false,
  onInspectChange,
  onSelectionChange,
  executions = noExecutions,
  averageCost,
}: Props) {
  const [width, setWidth] = useState(0);
  const candles = useMemo(() => {
    const distinct = new Map<number, Candle>();
    for (const candle of history.candles)
      if (validCandle(candle)) distinct.set(candle.time, candle);
    return [...distinct.values()].sort((a, b) => a.time - b.time);
  }, [history.candles]);
  const identity = `${history.symbol}:${range}`;
  const markers = useMemo(
    () => tradeMarkers(candles, range, history.symbol, executions),
    [candles, range, history.symbol, executions],
  );
  const cost =
    !compact && finite(averageCost) && averageCost > 0
      ? averageCost
      : undefined;
  const [windowState, setWindowState] = useState(() => ({
    identity,
    viewport: createViewport(candles.length),
  }));
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const [locatedSession, setLocatedSession] = useState<{ identity: string; session: TradingSession }>();
  const sessionChoice = locatedSession?.identity === identity ? locatedSession.session : undefined;
  const line = isLineRange(range) || compact;
  const viewport =
    windowState.identity === identity
      ? reconcileViewport(windowState.viewport, candles.length)
      : createViewport(candles.length);
  const bounds = line
    ? { first: 0, end: candles.length }
    : visibleRange(viewport);
  const indices = useMemo(
    () =>
      Array.from(
        { length: bounds.end - bounds.first },
        (_, index) => index + bounds.first,
      ),
    [bounds.first, bounds.end],
  );
  const visibleMarkers = useMemo(
    () =>
      compact
        ? []
        : markers.filter(
            (m) => m.index >= bounds.first && m.index < bounds.end,
          ),
    [markers, compact, bounds.first, bounds.end],
  );
  const closes = useMemo(
    () => candles.map((candle) => candle.close),
    [candles],
  );
  const averages = useMemo(
    () => (line ? [] : periods.map((period) => movingAverage(candles, period))),
    [candles, line],
  );
  const average = useMemo(
    () => (line && !compact ? sessionAverage(candles) : []),
    [candles, line, compact],
  );
  const extended = isLineRange(range) || minuteInterval(range) !== undefined;
  // Price ticks do not change timestamps. Avoid repeating IANA timezone/session
  // conversion across the entire history on every streaming paint.
  const candleTimes = candles.map((candle) => candle.time).join(",");
  const sessionLocations = useMemo(() => {
    const times = candles.map((candle) => candle.time);
    return sessions.map((session) => extended && !compact ? latestSessionLocation(times, session) : undefined);
  }, [candleTimes, extended, compact]);
  const located = sessionChoice ? sessionLocations[sessions.indexOf(sessionChoice)] : undefined;
  const metadata = useMemo(
    () =>
      candles.map((candle) => ({
        day: newYorkDateKey(candle.time),
        session: extended && !compact ? chartSessionWindow(candle.time)?.session : undefined,
      })),
    [candleTimes, extended, compact],
  );
  const days = useMemo(() => metadata.map((item) => item.day), [metadata]);
  const activeIndex = clamp(
    selectedIndex ?? bounds.end - 1,
    bounds.first,
    Math.max(bounds.first, bounds.end - 1),
  );
  const active = candles[activeIndex];
  const height =
    finite(requestedHeight) && requestedHeight > 0
      ? requestedHeight
      : compact
        ? 48
        : 320;
  const showToolbar = !compact && !line && height >= 130;
  const showSessionLegend = !compact && extended && height >= 220;
  const showSessionInfo = showSessionLegend && sessionChoice !== undefined;
  const showVolume = !compact && height >= 180;
  const wrapAverages = !compact && !line && width < 300;
  const headerHeight = compact
    ? 0
    : (wrapAverages ? 44 : 24) + (showToolbar ? 28 : 0) + (showSessionLegend ? 28 : 0) + (showSessionInfo ? 34 : 0);
  const svgHeight = Math.max(16, height - headerHeight);
  const left = compact ? 1 : 0;
  const plotWidth = Math.max(1, width - left - (compact ? 1 : 42));
  const plotRight = left + plotWidth;
  const plotTop = compact ? 2 : extended ? 19 : 6;
  const volumeHeight = showVolume
    ? Math.min(68, Math.max(34, svgHeight * 0.22))
    : 0;
  const priceHeight = Math.max(
    12,
    svgHeight -
      plotTop -
      (compact ? 3 : showVolume ? 2 : 20) -
      (showVolume ? volumeHeight + 34 : 0),
  );
  const priceBottom = plotTop + priceHeight;
  const volumeTop = priceBottom + 34;
  const plotBottom = showVolume ? volumeTop + volumeHeight : priceBottom;
  const lowerX = line ? -0.5 : viewport.start - 0.5;
  const span = Math.max(1, line ? candles.length : viewport.count);
  const x = (index: number): number =>
    left + ((index - lowerX) / span) * plotWidth;
  const domain = useMemo(() => {
    if (!line) return candlePriceDomain(candles, bounds.first, bounds.end);
    let low = Infinity;
    let high = -Infinity;
    const add = (value: number | undefined) => {
      if (finite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    };
    for (let index = bounds.first; index < bounds.end; index++) {
      if (line) {
        add(candles[index].close);
        add(average[index]);
      } else {
        add(candles[index].high);
        add(candles[index].low);
        for (const values of averages) add(values[index]);
      }
    }
    if (line) add(history.previousClose);
    if (!Number.isFinite(low) || !Number.isFinite(high))
      return { low: 0, high: 1 };
    const padding = Math.max(
      (high - low) * 0.08,
      Math.abs(high) * 0.0005,
      0.01,
    );
    return { low: low - padding, high: high + padding };
  }, [
    bounds.first,
    bounds.end,
    candles,
    line,
    average,
    averages,
    history.previousClose,
  ]);
  const y = (value: number): number =>
    plotTop +
    ((domain.high - value) / (domain.high - domain.low)) * priceHeight;
  const maxVolume = useMemo(
    () =>
      indices.reduce(
        (maximum, index) =>
          Math.max(
            maximum,
            finite(candles[index].volume)
              ? Math.max(0, candles[index].volume!)
              : 0,
          ),
        0,
      ),
    [indices, candles],
  );
  const dark = isDark(palette.background);
  const yellow = dark ? "#ffc44d" : "#9a6500";
  const maColors = [
    palette.text,
    dark ? "#ec85df" : "#aa278b",
    yellow,
    dark ? "#55b5ff" : "#087caf",
  ];
  const change =
    (candles.at(-1)?.close ?? 0) -
    (history.previousClose ?? candles[0]?.open ?? 0);
  const sparkColor =
    change > 0 ? palette.up : change < 0 ? palette.down : palette.secondary;
  const uniqueID = useId().replace(/[^a-zA-Z0-9]/g, "");
  const priceClip = `price-${uniqueID}`;
  const volumeClip = `volume-${uniqueID}`;
  const sparkFill = `spark-${uniqueID}`;

  const gesture = useRef<GestureBaseline | undefined>(undefined);
  const selectRef = useRef<(localX: number) => void>(() => {});
  const tapRef = useRef<(localX: number) => void>(() => {});
  tapRef.current = (localX) => {
    if (selectedIndex !== undefined) setSelectedIndex(undefined);
    else selectRef.current(localX);
  };
  const inspectRef = useRef(onInspectChange);
  inspectRef.current = onInspectChange;
  const interactionActive = useRef(false);
  const reportInteraction = (active: boolean) => {
    if (interactionActive.current === active) return;
    interactionActive.current = active;
    inspectRef.current?.(active);
  };
  const press = useMemo(
    () =>
      createChartPress(
        (localX) => selectRef.current(localX),
        (localX) => tapRef.current(localX),
      ),
    [],
  );
  selectRef.current = (localX) => {
    if (!candles.length) return;
    setSelectedIndex(
      clamp(
        Math.round(lowerX + (localX / plotWidth) * span),
        bounds.first,
        bounds.end - 1,
      ),
    );
    if (press.active) reportInteraction(true);
  };
  const finishPress = (cancel = false) => {
    if (cancel) press.cancel();
    else press.end();
    reportInteraction(chartInteractionActive(press.active, gesture.current !== undefined));
  };
  const finishPressRef = useRef(finishPress);
  finishPressRef.current = finishPress;
  const intent = useRef<ChartDragIntent>("undecided");
  const finishInteraction = (cancel = false) => {
    gesture.current = undefined;
    intent.current = "undecided";
    finishPressRef.current(cancel);
  };
  const finishInteractionRef = useRef(finishInteraction);
  finishInteractionRef.current = finishInteraction;
  const current = useRef({ identity, viewport, line, compact, plotWidth });
  current.current = { identity, viewport, line, compact, plotWidth };
  const commit = (next: CandleViewport) => {
    current.current.viewport = next;
    setWindowState({ identity: current.current.identity, viewport: next });
    finishPressRef.current(true);
    setSelectedIndex(undefined);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    setWindowState((previous) => ({
      identity,
      viewport:
        previous.identity === identity
          ? reconcileViewport(previous.viewport, candles.length)
          : createViewport(candles.length),
    }));
  }, [identity, candles.length]);
  useEffect(() => {
    setSelectedIndex(undefined);
    finishInteractionRef.current(true);
  }, [identity]);
  useEffect(() => {
    finishInteractionRef.current(true);
  }, [width, height]);

  useEffect(() => () => finishInteractionRef.current(true), []);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const cancel = () => finishInteractionRef.current(true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, []);

  const responder = useMemo(() => {
    const touches = (event: GestureResponderEvent) => event.nativeEvent.touches;
    const begin = (event: GestureResponderEvent) => {
      const points = touches(event);
      if (!points.length) return;
      const info = current.current;
      if (points.length === 1 && press.active) {
        press.move(points[0].pageX, points[0].pageY, points[0].locationX);
        return;
      }
      press.cancel();
      if (points.length >= 2) {
        const center = (points[0].locationX + points[1].locationX) / 2;
        gesture.current = {
          mode: "pinch",
          viewport: info.viewport,
          startX: center,
          distance: Math.max(
            1,
            Math.hypot(
              points[1].pageX - points[0].pageX,
              points[1].pageY - points[0].pageY,
            ),
          ),
          anchor: clamp(center / info.plotWidth, 0, 1),
          width: info.plotWidth,
        };
      } else {
        gesture.current = {
          mode: "pan",
          viewport: info.viewport,
          startX: points[0].pageX,
          distance: 1,
          anchor: 0.5,
          width: info.plotWidth,
        };
      }
      setSelectedIndex(undefined);
      reportInteraction(true);
    };
    const move = (event: GestureResponderEvent) => {
      const points = touches(event);
      if (!points.length) return;
      if (points.length === 1 && press.active) {
        press.move(points[0].pageX, points[0].pageY, points[0].locationX);
        return;
      }
      const baseline = gesture.current;
      if (!baseline || points.length >= 2 !== (baseline.mode === "pinch")) {
        begin(event);
        return;
      }
      if (baseline.mode === "pinch") {
        const distance = Math.hypot(
          points[1].pageX - points[0].pageX,
          points[1].pageY - points[0].pageY,
        );
        const center = (points[0].locationX + points[1].locationX) / 2;
        const zoomed = zoomViewport(
          baseline.viewport,
          distance / baseline.distance,
          baseline.anchor,
        );
        commitRef.current(
          panViewport(zoomed, center - baseline.startX, baseline.width),
        );
      } else {
        commitRef.current(
          panViewport(
            baseline.viewport,
            points[0].pageX - baseline.startX,
            baseline.width,
          ),
        );
      }
    };
    const shouldClaim = (
      event: GestureResponderEvent,
      state: PanResponderGestureState,
    ) => {
      if (current.current.compact) return false;
      if (touches(event).length >= 2) return !current.current.line;
      if (press.active) return true;
      if (current.current.line) return false;
      intent.current = chartDragIntent(intent.current, state.dx, state.dy);
      if (intent.current === "horizontal") reportInteraction(true);
      return intent.current === "horizontal";
    };
    const finish = () => {
      finishInteractionRef.current();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: (event) =>
        !current.current.line &&
        !current.current.compact &&
        touches(event).length >= 2,
      onStartShouldSetPanResponderCapture: (event) =>
        !current.current.line &&
        !current.current.compact &&
        touches(event).length >= 2,
      onMoveShouldSetPanResponder: shouldClaim,
      onMoveShouldSetPanResponderCapture: shouldClaim,
      onPanResponderGrant: begin,
      onPanResponderReject: () => finishInteractionRef.current(true),
      onPanResponderMove: move,
      onPanResponderStart: (event) => {
        if (gesture.current) move(event);
      },
      onPanResponderEnd: (event) => {
        if (gesture.current && touches(event).length) move(event);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: () => {
        finishInteractionRef.current(true);
      },
      onPanResponderTerminationRequest: () =>
        !press.active && gesture.current === undefined,
      onShouldBlockNativeResponder: () => true,
    });
  }, []);

  const sessionSegments = useMemo(() => {
    const result: SessionSegment[] = [];
    if (!extended || compact) return result;
    for (const index of indices) {
      const { session, day } = metadata[index];
      if (!session || !day) continue;
      const last = result.at(-1);
      if (
        last &&
        last.session === session &&
        last.day === day &&
        last.end === index
      )
        last.end = index + 1;
      else result.push({ session, day, first: index, end: index + 1 });
    }
    return result;
  }, [indices, metadata, extended, compact]);
  const sessionColor = (session: TradingSession) =>
    session === "overnight"
      ? (dark ? "#bb91f5" : "#7543b5")
      : session === "premarket"
      ? palette.premarket
      : session === "postmarket"
        ? palette.postmarket
        : palette.secondary;
  const selected =
    selectedIndex !== undefined &&
    selectedIndex >= bounds.first &&
    selectedIndex < bounds.end;
  useEffect(() => {
    onSelectionChange?.(selected ? active : undefined);
  }, [selected, active, onSelectionChange]);
  useEffect(() => () => onSelectionChange?.(undefined), [onSelectionChange]);
  const candleWidth = Math.max(0.65, Math.min(12, (plotWidth / span) * 0.65));
  const formingIndex =
    !line && !compact && candles.at(-1)?.provisional ? candles.length - 1 : -1;
  const candlePaths = {
    up: "",
    down: "",
    upWicks: "",
    downWicks: "",
    upVolume: "",
    downVolume: "",
  };
  for (const index of indices) {
    const candle = candles[index];
    const up = candle.close >= candle.open;
    const center = x(index);
    if (!line && index !== formingIndex) {
      candlePaths[up ? "upWicks" : "downWicks"] +=
        `M${center},${y(candle.high)}V${y(candle.low)} `;
      const top = Math.min(y(candle.open), y(candle.close));
      const body = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
      candlePaths[up ? "up" : "down"] +=
        `M${center - candleWidth / 2},${top}h${candleWidth}v${body}h${-candleWidth}Z `;
    }
    if (
      showVolume &&
      finite(candle.volume) &&
      candle.volume > 0 &&
      maxVolume > 0
    ) {
      const barHeight = (candle.volume / maxVolume) * volumeHeight;
      candlePaths[up ? "upVolume" : "downVolume"] +=
        `M${center - candleWidth / 2},${volumeTop + volumeHeight}h${candleWidth}v${-barHeight}h${-candleWidth}Z `;
    }
  }
  const actualPath = linePath(
    indices,
    closes,
    x,
    y,
    compact ? undefined : days,
  );
  const averagePath =
    !compact && line ? linePath(indices, average, x, y, days) : "";
  const first = candles[bounds.first];
  const last = candles[bounds.end - 1];
  const differentDays =
    first &&
    last &&
    metadata[bounds.first].day !== metadata[bounds.end - 1].day;
  const tickLabel = (index: number) => {
    const at = candles[index].time;
    if (minuteInterval(range) !== undefined)
      return differentDays ? dateTime(at) : timeFormatter.format(at);
    return range === "intraday"
      ? timeFormatter.format(at)
      : dateFormatter.format(at);
  };
  let ticks = indices.length
    ? [
        bounds.first,
        Math.floor((bounds.first + bounds.end - 1) / 2),
        bounds.end - 1,
      ]
    : [];
  if (range === "fiveDay")
    ticks = indices.filter(
      (index) =>
        index === bounds.first ||
        metadata[index].day !== metadata[index - 1]?.day,
    );
  ticks = [...new Set(ticks)];
  if (plotWidth < 220 && ticks.length > 2)
    ticks = [ticks[0], ticks[ticks.length - 1]];
  const windowDescription =
    bounds.end === candles.length
      ? `最近 ${bounds.end - bounds.first} 根`
      : `第 ${bounds.first + 1}–${bounds.end} 根`;
  const latest = () => {
    setLocatedSession(undefined);
    commit(createViewport(candles.length));
  };
  const locateSession = (session: TradingSession) => {
    setLocatedSession({ identity, session });
    const location = sessionLocations[sessions.indexOf(session)];
    if (location && !line) commit(sessionViewport(candles.length, location));
  };

  return (
    <View
      testID={compact ? `watchlist.chart.${history.symbol}` : "detail.chart"}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (Number.isFinite(next) && next > 0) setWidth(next);
      }}
      style={{
        height,
        width: "100%",
        backgroundColor: compact ? "transparent" : palette.background,
        overflow: "hidden",
      }}
      pointerEvents={compact ? "none" : "auto"}
    >
      {!compact && (
        <View
          style={[styles.legend, wrapAverages && { height: 44, flexWrap: "wrap", columnGap: 0, rowGap: 0 }]}
          testID={line ? "chart.average" : "chart.movingAverages"}
        >
          {line ? (
            <>
              <Text
                numberOfLines={1}
                style={[styles.legendText, { color: yellow, flex: 1.3 }]}
              >
                均价估算 {price(average[activeIndex])}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.legendText, { color: palette.text, flex: 1 }]}
              >
                价格 {price(active?.close)}
              </Text>
            </>
          ) : (
            periods.map((period, index) => (
              <Text
                key={period}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                testID={`chart.ma${period}`}
                style={[styles.legendText, { color: maColors[index] }, wrapAverages ? { width: "50%", lineHeight: 22 } : { flex: 1 }]}
              >
                MA{period} {price(averages[index]?.[activeIndex])}
              </Text>
            ))
          )}
        </View>
      )}
      {showSessionLegend && (
        <View testID="chart.sessionLegend" style={styles.sessionLegend}>
          {sessions.map((session) => (
            <Pressable key={session} style={[styles.sessionKey, { minHeight: 28 }]}
              testID={`chart.session.${session}`}
              accessibilityRole="button"
              accessibilityLabel={`查看最近有数据的${sessionTitles[session]}`}
              accessibilityState={{ selected: sessionChoice === session }}
              onPress={() => locateSession(session)}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: sessionColor(session),
                }}
              />
              <Text style={[styles.small, { color: sessionChoice === session ? palette.accent : palette.secondary }]}>
                {sessionTitles[session]}
              </Text>
            </Pressable>
          ))}
          <Text
            style={[
              styles.small,
              { color: palette.secondary, marginLeft: "auto" },
            ]}
          >
            点时段定位 · 美东
          </Text>
        </View>
      )}
      {showSessionInfo && (
        <View style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text testID="chart.sessionInfo" numberOfLines={2}
            style={[styles.small, { color: palette.secondary, flex: 1, lineHeight: 15 }]}>
            {located
              ? `${sessionTitles[sessionChoice!]}最近有数据：${dateTime(located.firstTime)}–${dateTime(located.lastTime)} 美东 · ${located.count}根${line ? "（图中已包含）" : ""}`
              : `${candles.length ? `已加载 ${dateTime(candles[0].time)}–${dateTime(candles.at(-1)!.time)} 美东；` : ""}未包含${sessionTitles[sessionChoice!]}K线，可刷新重试。`}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭时段说明" hitSlop={6}
            onPress={() => setLocatedSession(undefined)} style={styles.chartButton}>
            <Text style={{ color: palette.secondary }}>×</Text>
          </Pressable>
        </View>
      )}
      {showToolbar && (
        <View style={styles.controls}>
          <Text
            testID="chart.window"
            accessibilityLabel={`第${bounds.first + 1}至${bounds.end}根，共${candles.length}根`}
            numberOfLines={1}
            style={[styles.small, { color: palette.secondary, flex: 1 }]}
          >
            {windowDescription} · 美东时间
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="缩小K线"
            testID="chart.zoomOut"
            hitSlop={4}
            onPress={() => commit(zoomViewport(viewport, 0.75, 0.5))}
            style={styles.chartButton}
          >
            <Text style={[styles.controlText, { color: palette.accent }]}>
              −
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="放大K线"
            testID="chart.zoomIn"
            hitSlop={4}
            onPress={() => commit(zoomViewport(viewport, 1.4, 0.5))}
            style={styles.chartButton}
          >
            <Text style={[styles.controlText, { color: palette.accent }]}>
              ＋
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="回到最新K线"
            testID="chart.latest"
            hitSlop={4}
            onPress={latest}
            style={styles.chartButton}
          >
            <Text style={[styles.small, { color: palette.accent }]}>
              ⇥ 最新
            </Text>
          </Pressable>
        </View>
      )}
      <View style={{ height: svgHeight, position: "relative" }}>
        {width > 0 && candles.length > 0 ? (
          <Svg
            width={width}
            height={svgHeight}
            testID="chart.plot"
            pointerEvents="none"
          >
            <Defs>
              <ClipPath id={priceClip}>
                <Rect
                  x={left}
                  y={plotTop}
                  width={plotWidth}
                  height={priceHeight}
                />
              </ClipPath>
              <ClipPath id={volumeClip}>
                <Rect
                  x={left}
                  y={volumeTop}
                  width={plotWidth}
                  height={volumeHeight}
                />
              </ClipPath>
              <LinearGradient id={sparkFill} x1="0%" y1="0%" x2="0%" y2="100%">
                <Stop offset="0" stopColor={sparkColor} stopOpacity={0.24} />
                <Stop offset="1" stopColor={sparkColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {sessionSegments.map((segment) => {
              const start = Math.max(left, x(segment.first - 0.5));
              const end = Math.min(plotRight, x(segment.end - 0.5));
              if (end <= start) return null;
              return (
                <G key={`${segment.day}-${segment.session}-${segment.first}`}>
                  {segment.session !== "regular" && (
                    <>
                      <Rect
                        x={start}
                        y={plotTop}
                        width={end - start}
                        height={priceHeight}
                        fill={sessionColor(segment.session)}
                        opacity={dark ? 0.18 : 0.11}
                      />
                      {showVolume && (
                        <Rect
                          x={start}
                          y={volumeTop}
                          width={end - start}
                          height={volumeHeight}
                          fill={sessionColor(segment.session)}
                          opacity={dark ? 0.18 : 0.11}
                        />
                      )}
                    </>
                  )}
                  {end - start >= 30 && (
                    <SvgText
                      x={(start + end) / 2}
                      y={12}
                      fill={sessionColor(segment.session)}
                      fontSize={10}
                      textAnchor="middle"
                    >
                      {sessionTitles[segment.session]}
                    </SvgText>
                  )}
                </G>
              );
            })}
            {!compact &&
              [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                const value =
                  domain.high - (domain.high - domain.low) * fraction;
                const position = y(value);
                return (
                  <G key={fraction}>
                    <Line
                      x1={left}
                      x2={plotRight}
                      y1={position}
                      y2={position}
                      stroke={palette.separator}
                      strokeWidth={0.7}
                    />
                    <SvgText
                      x={plotRight + 5}
                      y={
                        position +
                        (fraction === 0 ? 9 : fraction === 1 ? -2 : 3)
                      }
                      fill={palette.secondary}
                      fontSize={10}
                    >
                      {Math.abs(value) >= 1_000_000
                        ? `${(value / 1_000_000).toFixed(2)}M`
                        : price(value)}
                    </SvgText>
                  </G>
                );
              })}
            {!compact &&
              [0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                <Line
                  key={`vertical-${fraction}`}
                  x1={left + plotWidth * fraction}
                  x2={left + plotWidth * fraction}
                  y1={plotTop}
                  y2={priceBottom}
                  stroke={palette.separator}
                  strokeWidth={0.6}
                  strokeDasharray="3 3"
                />
              ))}
            {finite(history.previousClose) && line && (
              <Line
                x1={left}
                x2={plotRight}
                y1={y(history.previousClose)}
                y2={y(history.previousClose)}
                stroke={palette.secondary}
                strokeDasharray="4 4"
                strokeWidth={0.7}
                opacity={0.7}
              />
            )}
            <G clipPath={`url(#${priceClip})`}>
              {compact && actualPath && first && last && (
                <Path
                  d={`${actualPath} L${x(bounds.end - 1)},${priceBottom} L${x(bounds.first)},${priceBottom}Z`}
                  fill={`url(#${sparkFill})`}
                />
              )}
              {line ? (
                <>
                  <Path
                    d={actualPath}
                    stroke={compact ? sparkColor : palette.text}
                    strokeWidth={compact ? 1.35 : 1.5}
                    fill="none"
                  />
                  {!compact && (
                    <Path
                      d={averagePath}
                      stroke={yellow}
                      strokeWidth={1.4}
                      fill="none"
                    />
                  )}
                  {candles.length === 1 && (
                    <Circle
                      cx={x(0)}
                      cy={y(candles[0].close)}
                      r={2}
                      fill={compact ? sparkColor : palette.text}
                    />
                  )}
                </>
              ) : (
                <>
                  <Path
                    d={candlePaths.upWicks}
                    stroke={palette.up}
                    strokeWidth={0.85}
                    fill="none"
                  />
                  <Path
                    d={candlePaths.downWicks}
                    stroke={palette.down}
                    strokeWidth={0.85}
                    fill="none"
                  />
                  <Path d={candlePaths.up} fill={palette.up} />
                  <Path d={candlePaths.down} fill={palette.down} />
                  {formingIndex >= bounds.first &&
                    formingIndex < bounds.end && (
                      <FormingCandle
                        key={`${identity}:${candles[formingIndex].time}`}
                        x={x(formingIndex)}
                        width={candleWidth}
                        open={y(candles[formingIndex].open)}
                        high={y(candles[formingIndex].high)}
                        low={y(candles[formingIndex].low)}
                        close={y(candles[formingIndex].close)}
                        up={palette.up}
                        down={palette.down}
                      />
                    )}
                  {averages.map((values, index) => (
                    <Path
                      key={periods[index]}
                      d={linePath(indices, values, x, y)}
                      stroke={maColors[index]}
                      strokeWidth={1.2}
                      fill="none"
                    />
                  ))}
                </>
              )}
              {cost !== undefined && (
                <G testID="chart.costBasis">
                  {cost >= domain.low && cost <= domain.high && <Line
                    x1={left}
                    x2={plotRight}
                    y1={y(cost)}
                    y2={y(cost)}
                    stroke={palette.accent}
                    strokeWidth={1.2}
                    strokeDasharray="6 4"
                  />}
                  <Rect
                    x={left + 2}
                    y={clamp(y(cost) - 17, plotTop, priceBottom - 17)}
                    width={122}
                    height={16}
                    rx={3}
                    fill={palette.background}
                    opacity={0.9}
                  />
                  <SvgText
                    x={left + 6}
                    y={clamp(y(cost) - 17, plotTop, priceBottom - 17) + 12}
                    fill={palette.accent}
                    fontSize={11}
                  >
                    {cost > domain.high ? "↑ " : cost < domain.low ? "↓ " : ""}成本 {price(cost)}
                  </SvgText>
                </G>
              )}
              {visibleMarkers.map((marker) => {
                const cx = clamp(x(marker.index), left + 10, plotRight - 10);
                const py = y(marker.price);
                const cy = clamp(
                  py + (marker.side === "BUY" ? 17 : -17),
                  plotTop + 10,
                  priceBottom - 10,
                );
                const tint = marker.side === "BUY" ? palette.up : palette.down;
                return (
                  <G
                    key={`${marker.index}:${marker.side}`}
                    testID={`chart.execution.${marker.index}.${marker.side}`}
                  >
                    <Line
                      x1={x(marker.index)}
                      x2={cx}
                      y1={py}
                      y2={cy}
                      stroke={tint}
                      strokeWidth={1}
                    />
                    <Circle cx={x(marker.index)} cy={py} r={2.5} fill={tint} />
                    <Circle
                      cx={cx}
                      cy={cy}
                      r={8}
                      fill={tint}
                      stroke={palette.background}
                      strokeWidth={1}
                    />
                    <SvgText
                      x={cx}
                      y={cy + 3.5}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={10}
                      fontWeight="700"
                    >
                      {marker.side === "BUY" ? "B" : "S"}
                    </SvgText>
                  </G>
                );
              })}
              {selected && active && (
                <>
                  <Line
                    testID="chart.crosshair.vertical"
                    x1={x(activeIndex)}
                    x2={x(activeIndex)}
                    y1={plotTop}
                    y2={priceBottom}
                    stroke={palette.secondary}
                    strokeDasharray="3 3"
                  />
                  <Line
                    testID="chart.crosshair.horizontal"
                    x1={left}
                    x2={plotRight}
                    y1={y(active.close)}
                    y2={y(active.close)}
                    stroke={palette.secondary}
                    strokeDasharray="3 3"
                  />
                  <Circle
                    cx={x(activeIndex)}
                    cy={y(active.close)}
                    r={3}
                    fill={palette.accent}
                  />
                </>
              )}
            </G>
            {showVolume && (
              <G testID="chart.volume">
                <SvgText
                  x={left}
                  y={volumeTop - 5}
                  fill={palette.secondary}
                  fontSize={10}
                >
                  成交量 {volumeText(active?.volume)}
                </SvgText>
                <SvgText
                  x={width - 1}
                  textAnchor="end"
                  y={volumeTop - 5}
                  fill={palette.secondary}
                  fontSize={10}
                >
                  {volumeText(maxVolume)}
                </SvgText>
                <Line
                  x1={left}
                  x2={plotRight}
                  y1={volumeTop + volumeHeight}
                  y2={volumeTop + volumeHeight}
                  stroke={palette.separator}
                  strokeWidth={0.7}
                />
                <G clipPath={`url(#${volumeClip})`}>
                  <Path
                    d={candlePaths.upVolume}
                    fill={palette.up}
                    opacity={0.8}
                  />
                  <Path
                    d={candlePaths.downVolume}
                    fill={palette.down}
                    opacity={0.8}
                  />
                  {selected && (
                    <Line
                      x1={x(activeIndex)}
                      x2={x(activeIndex)}
                      y1={volumeTop}
                      y2={volumeTop + volumeHeight}
                      stroke={palette.secondary}
                      strokeDasharray="3 3"
                    />
                  )}
                </G>
              </G>
            )}
            {!compact &&
              ticks.map((index, position) => (
                <SvgText
                  key={index}
                  x={
                    position === 0
                      ? left
                      : position === ticks.length - 1
                        ? plotRight
                        : x(index)
                  }
                  y={showVolume ? priceBottom + 13 : svgHeight - 3}
                  textAnchor={
                    position === 0
                      ? "start"
                      : position === ticks.length - 1
                        ? "end"
                        : "middle"
                  }
                  fill={palette.secondary}
                  fontSize={10}
                >
                  {tickLabel(index)}
                </SvgText>
              ))}
            {selected && active && (
              <G>
                <Rect
                  x={left}
                  y={svgHeight - 16}
                  width={plotWidth}
                  height={16}
                  fill={palette.background}
                />
                <SvgText
                  x={left + 2}
                  y={svgHeight - 4}
                  fontSize={10}
                  fill={palette.text}
                >
                  {dateTime(active.time)}　收 {price(active.close)}　量{" "}
                  {volumeText(active.volume)}
                </SvgText>
              </G>
            )}
          </Svg>
        ) : (
          <View style={styles.empty}>
            <Text
              style={{ color: palette.secondary, fontSize: compact ? 11 : 12 }}
            >
              {compact ? "—" : "暂无行情数据"}
            </Text>
          </View>
        )}
        {!compact && candles.length > 0 && width > 0 && (
          <View
            {...responder.panHandlers}
            testID="chart.gesture"
            accessible
            accessibilityRole={line ? "image" : "adjustable"}
            accessibilityLabel={`${history.symbol} ${rangeTitle(range)}，第${bounds.first + 1}至${bounds.end}根，共${candles.length}根${active ? `，价格${price(active.close)}` : ""}`}
            accessibilityHint={
              line
                ? "长按出现十字线，左右移动查看价格；松手保留选点，再轻点退出；上下滑动页面。"
                : "长按后左右移动查看价格，再轻点退出；普通单指拖动平移，双指缩放，上下滑动页面。"
            }
            accessibilityActions={
              line
                ? []
                : [
                    { name: "increment", label: "放大K线" },
                    { name: "decrement", label: "缩小K线" },
                    { name: "latest", label: "回到最新K线" },
                  ]
            }
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "latest") latest();
              else
                commit(
                  zoomViewport(
                    viewport,
                    event.nativeEvent.actionName === "increment" ? 1.4 : 0.75,
                    0.5,
                  ),
                );
            }}
            style={{
              position: "absolute",
              left,
              top: plotTop,
              width: plotWidth,
              height: Math.max(1, plotBottom - plotTop),
            }}
            onTouchStart={(event) => {
              if (event.nativeEvent.touches.length !== 1 || gesture.current) {
                press.cancel();
                return;
              }
              const touch = event.nativeEvent.touches[0];
              intent.current = "undecided";
              press.start(touch.pageX, touch.pageY, touch.locationX);
            }}
            onTouchMove={(event) => {
              const points = event.nativeEvent.touches;
              if (points.length !== 1) {
                finishPressRef.current(true);
                return;
              }
              press.move(points[0].pageX, points[0].pageY, points[0].locationX);
            }}
            onTouchEnd={(event) => {
              if (!event.nativeEvent.touches.length) {
                finishInteractionRef.current();
              }
            }}
            onTouchCancel={() => finishInteractionRef.current(true)}
            {...(Platform.OS === "web"
              ? {
                  onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
                    if (event.button !== 0) return;
                    intent.current = "undecided";
                    press.start(
                      event.pageX,
                      event.pageY,
                      event.clientX -
                        event.currentTarget.getBoundingClientRect().left,
                    );
                  },
                  onMouseMove: (event: React.MouseEvent<HTMLElement>) => {
                    if (event.buttons !== 1) {
                      finishInteractionRef.current(true);
                      return;
                    }
                    press.move(
                      event.pageX,
                      event.pageY,
                      event.clientX -
                        event.currentTarget.getBoundingClientRect().left,
                    );
                  },
                  onMouseUp: () => finishInteractionRef.current(),
                  onMouseLeave: () => finishInteractionRef.current(true),
                  onContextMenu: (event: React.MouseEvent<HTMLElement>) =>
                    event.preventDefault(),
                }
              : {})}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 0,
    gap: 5,
  },
  legendText: { fontSize: 11, fontVariant: ["tabular-nums"] },
  sessionLegend: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 0,
  },
  sessionKey: { flexDirection: "row", alignItems: "center", gap: 4 },
  small: { fontSize: 10, fontVariant: ["tabular-nums"] },
  controls: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 0,
    gap: 3,
  },
  chartButton: {
    minWidth: 30,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  controlText: { fontSize: 17, lineHeight: 21 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
});

export default React.memo(MarketChart);
