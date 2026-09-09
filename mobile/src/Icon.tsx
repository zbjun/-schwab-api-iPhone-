import React from "react";
import { Platform } from "react-native";
import Svg, { Circle, Path, Rect, Line } from "react-native-svg";

/** Small vector icons keep the original navigation shapes without a font dependency. */
export function Icon({
  name,
  size = 24,
  color = "currentColor",
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  const common = {
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const cutout = color.toUpperCase() === "#F5F7FA" ? "#1A1C1F" : "#fff";
  let shape;
  switch (name) {
    case "settings":
      shape = <>
        <Path {...common} d="M10 2h4l.5 3 2 1.2 2.8-1 2 3.5-2.3 2v2.6l2.3 2-2 3.5-2.8-1-2 1.2-.5 3h-4l-.5-3-2-1.2-2.8 1-2-3.5 2.3-2v-2.6l-2.3-2 2-3.5 2.8 1 2-1.2Z" />
        <Circle {...common} cx="12" cy="12" r="3.3" />
      </>;
      break;
    case "star":
      shape = (
        <Path
          d="m12 2 3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.6l-6.1 3.2 1.2-6.8-4.9-4.8 6.8-1Z"
          fill={color}
          stroke={color}
          strokeLinejoin="round"
        />
      );
      break;
    case "star-outline":
      shape = (
        <Path
          {...common}
          d="m12 2 3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.6l-6.1 3.2 1.2-6.8-4.9-4.8 6.8-1Z"
        />
      );
      break;
    case "accounts":
    case "pie":
      shape = (
        <>
          <Path d="M10.5 2a10 10 0 1 0 10.4 12H10.5Z" fill={color} />
          <Path
            d="M13 1.8v9l7.3-5.2A9.5 9.5 0 0 0 13 1.8ZM14 12.8l7 7a10 10 0 0 0 1-12.8Z"
            fill={color}
          />
        </>
      );
      break;
    case "trade":
    case "arrows":
      shape = (
        <Path {...common} d="M20 6H3m0 0 5-4M3 6l5 4M4 17h17m0 0-5-4m5 4-5 4" />
      );
      break;
    case "orders":
      shape = (
        <>
          <Rect x="2" y="2" width="20" height="20" rx="3" fill={color} />
          <Path
            d="M9 7h9M9 12h9M9 17h9"
            stroke={cutout}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <Circle cx="5.5" cy="7" r=".9" fill={cutout} />
          <Circle cx="5.5" cy="12" r=".9" fill={cutout} />
          <Circle cx="5.5" cy="17" r=".9" fill={cutout} />
        </>
      );
      break;
    case "link":
      shape = (
        <Path
          {...common}
          d="m10 14 4-4m-5-2 3-4a5 5 0 0 1 7 7l-3 4m-1 1-3 4a5 5 0 0 1-7-7l3-4"
        />
      );
      break;
    case "refresh":
      shape = <Path {...common} d="M16 3 20 6l-4 3m4-3h-7a8 8 0 1 0 8 8" />;
      break;
    case "plus":
      shape = <Path {...common} d="M12 4v16M4 12h16" />;
      break;
    case "minus":
      shape = <Path {...common} d="M4 12h16" />;
      break;
    case "search":
      shape = (
        <>
          <Circle {...common} cx="10" cy="10" r="6.5" />
          <Path {...common} d="m15 15 6 6" />
        </>
      );
      break;
    case "back":
    case "chevron-left":
      shape = <Path {...common} d="m15 3-9 9 9 9" />;
      break;
    case "chevron":
    case "chevron-right":
      shape = <Path {...common} d="m9 4 8 8-8 8" />;
      break;
    case "down":
    case "chevron-down":
      shape = <Path {...common} d="m5 9 7 7 7-7" />;
      break;
    case "select":
      shape = <Path {...common} d="m8 8 4-4 4 4m-8 8 4 4 4-4" />;
      break;
    case "close":
    case "x":
      shape = <Path {...common} d="m5 5 14 14M5 19 19 5" />;
      break;
    case "list":
      shape = (
        <>
          <Path {...common} d="M8 6h13M8 12h13M8 18h13" />
          <Circle cx="3" cy="6" r="1.2" fill={color} />
          <Circle cx="3" cy="12" r="1.2" fill={color} />
          <Circle cx="3" cy="18" r="1.2" fill={color} />
        </>
      );
      break;
    case "chart":
      shape = (
        <>
          <Path {...common} d="M3 3v18h19M5 15l5-6 5 4 6-7" />
          <Circle cx="10" cy="9" r="2" fill={color} />
          <Circle cx="15" cy="13" r="2" fill={color} />
          <Circle cx="21" cy="6" r="2" fill={color} />
        </>
      );
      break;
    case "sparkles":
      shape = (
        <>
          <Path
            d="m13 4 2.4 7.2L22 14l-6.6 2.4L13 23l-2.4-6.6L4 14l6.6-2.8ZM5 0l1.2 3.5L10 5 6.2 6.3 5 10 3.7 6.3 0 5l3.7-1.5Z"
            fill={color}
          />
        </>
      );
      break;
    case "phone":
      shape = (
        <>
          <Rect {...common} x="7" y="1" width="11" height="22" rx="2" />
          <Line {...common} x1="10" y1="4" x2="14" y2="4" />
          <Line {...common} x1="10" y1="20" x2="14" y2="20" />
        </>
      );
      break;
    case "arrow-right":
      shape = <Path {...common} d="M2 12h19m-6-6 6 6-6 6" />;
      break;
    case "shield":
    case "lock":
      shape = (
        <>
          <Path {...common} d="m12 2 9 4v7c0 5-9 9-9 9s-9-4-9-9V6Z" />
          <Rect {...common} x="8" y="10" width="8" height="7" rx="1" />
          <Path {...common} d="M10 10V8a2 2 0 0 1 4 0v2" />
        </>
      );
      break;
    case "globe":
      shape = (
        <>
          <Circle {...common} cx="12" cy="12" r="10" />
          <Path
            {...common}
            d="M2 12h20M4 6c5 3 11 3 16 0M4 18c5-3 11-3 16 0M12 2c-6 6-6 14 0 20 6-6 6-14 0-20"
          />
        </>
      );
      break;
    case "bank":
      shape = (
        <Path
          {...common}
          d="m2 7 10-5 10 5ZM4 10v8m5-8v8m6-8v8m5-8v8M2 21h20M3 18h18"
        />
      );
      break;
    case "check":
      shape = <Path {...common} d="m4 12 5 5L21 5" />;
      break;
    default:
      shape = (
        <>
          <Circle {...common} cx="12" cy="12" r="10" />
          <Path {...common} d="M12 11v6" />
          <Circle cx="12" cy="7" r="1.1" fill={color} />
        </>
      );
  }
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...(Platform.OS === "web"
        ? { "aria-hidden": true }
        : { accessible: false })}
    >
      {shape}
    </Svg>
  );
}
