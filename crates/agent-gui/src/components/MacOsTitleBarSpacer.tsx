import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { cn } from "../lib/shared/utils";
import { PanelLeft, PanelLeftClose, Settings } from "./icons";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

type MacOsTrafficLightMetrics = {
  top: number;
  left: number;
  width: number;
  height: number;
};

// Fallback values match tauri.conf.json; runtime AppKit metrics replace them on macOS.
const MAC_OS_TRAFFIC_LIGHT_TOP = 18;
const MAC_OS_TRAFFIC_LIGHT_DIAMETER = 12;
const MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE = 28;

function isValidMetrics(
  metrics: MacOsTrafficLightMetrics | null,
): metrics is MacOsTrafficLightMetrics {
  return Boolean(
    metrics &&
      Number.isFinite(metrics.top) &&
      Number.isFinite(metrics.left) &&
      Number.isFinite(metrics.width) &&
      Number.isFinite(metrics.height) &&
      metrics.width > 0 &&
      metrics.height > 0,
  );
}

function useMacOsTrafficLightMetrics(enabled: boolean) {
  const [metrics, setMetrics] = useState<MacOsTrafficLightMetrics | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMetrics(null);
      return undefined;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await invoke<MacOsTrafficLightMetrics | null>(
          "app_macos_traffic_light_metrics",
        );
        if (!cancelled && isValidMetrics(next)) {
          setMetrics(next);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("failed to read macOS traffic light metrics", error);
          setMetrics(null);
        }
      }
    };

    void refresh();
    window.addEventListener("resize", refresh);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", refresh);
    };
  }, [enabled]);

  return metrics;
}

export function isMacOsTauri(): boolean {
  if (typeof window === "undefined") return false;
  const hasTauri = !!(window as TauriWindow).__TAURI_INTERNALS__;
  return hasTauri && /Mac/i.test(navigator.platform);
}

/** Vertical spacer at the top of a sidebar column — clears the macOS traffic lights. */
export function MacOsTitleBarSpacer({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return <div data-tauri-drag-region className={cn("h-[38px] shrink-0", className)} />;
}

/**
 * Fixed-position sidebar toggle for macOS overlay titlebar.
 * Always appears at the same x position (right of traffic lights), regardless of sidebar state.
 */
export function MacOsTitleBarToggle({
  sidebarOpen,
  onToggle,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const [show] = useState(isMacOsTauri);
  const trafficLightMetrics = useMacOsTrafficLightMetrics(show);
  if (!show) return null;
  const trafficLightTop = trafficLightMetrics?.top ?? MAC_OS_TRAFFIC_LIGHT_TOP;
  const trafficLightHeight = trafficLightMetrics?.height ?? MAC_OS_TRAFFIC_LIGHT_DIAMETER;
  const toggleTop = trafficLightTop - (MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE - trafficLightHeight) / 2;
  return (
    <div
      className="fixed left-[92px] z-49 flex items-center gap-0.5 [-webkit-app-region:no-drag]"
      style={{
        top: toggleTop,
        height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]"
        style={{
          height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
          width: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
        }}
      >
        {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
      </button>
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]"
          style={{
            height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
            width: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
          }}
        >
          <Settings className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Horizontal spacer on the left of a header row — used in ChatHeader when sidebar is
 * closed on macOS to clear the traffic lights + fixed toggle button zone.
 */
export function MacOsTitleBarLeadingInset({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return <div data-tauri-drag-region className={cn("w-[88px] shrink-0", className)} />;
}
