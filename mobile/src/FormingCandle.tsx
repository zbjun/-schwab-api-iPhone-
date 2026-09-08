import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import { G, Line, Rect } from "react-native-svg";
import { createCandleMotion, type CandleGeometry } from "./candleMotion.ts";

function FormingCandle({
  x,
  width,
  open,
  high,
  low,
  close,
  up,
  down,
}: CandleGeometry & { x: number; width: number; up: string; down: string }) {
  const [geometry, setGeometry] = useState({ open, high, low, close });
  const [reduceMotion, setReduceMotion] = useState(true);
  const [active, setActive] = useState(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const motion = useRef<ReturnType<typeof createCandleMotion> | null>(null);
  if (!motion.current)
    motion.current = createCandleMotion(geometry, setGeometry, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    });
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduceMotion(value);
      })
      .catch(() => {});
    const reduce = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    const state = AppState.addEventListener("change", (value) =>
      setActive(value === "active"),
    );
    return () => {
      mounted = false;
      reduce.remove();
      state.remove();
      motion.current?.stop();
    };
  }, []);
  useEffect(() => {
    motion.current!.move({ open, high, low, close }, active && !reduceMotion);
    return () => motion.current!.stop();
  }, [open, high, low, close, active, reduceMotion]);
  const color = geometry.close <= geometry.open ? up : down;
  return (
    <G testID="chart.formingCandle">
      <Line
        x1={x}
        x2={x}
        y1={geometry.high}
        y2={geometry.low}
        stroke={color}
        strokeWidth={0.85}
      />
      <Rect
        x={x - width / 2}
        y={Math.min(geometry.open, geometry.close)}
        width={width}
        height={Math.max(1, Math.abs(geometry.open - geometry.close))}
        fill={color}
      />
    </G>
  );
}
export default React.memo(FormingCandle);
