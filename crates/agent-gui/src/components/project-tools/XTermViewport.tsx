import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, type CSSProperties } from "react";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
} from "../../lib/terminal/types";

type XTermViewportProps = {
  client: TerminalClient;
  session: TerminalSession;
  theme: "light" | "dark";
  isActive: boolean;
  initialSnapshot?: TerminalSnapshot;
  className?: string;
  onError: (message: string | null) => void;
  onInitialSnapshotConsumed?: (sessionId: string) => void;
};

function terminalTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#0b0f14",
      foreground: "#d6deeb",
      cursor: "#f8fafc",
      cursorAccent: "#0b0f14",
      selectionBackground: "#2c3e57",
      selectionInactiveBackground: "#22304a",
      scrollbarSliderBackground: "rgba(148, 163, 184, 0.18)",
      scrollbarSliderHoverBackground: "rgba(148, 163, 184, 0.3)",
      scrollbarSliderActiveBackground: "rgba(148, 163, 184, 0.42)",
      overviewRulerBorder: "transparent",
      black: "#1b2733",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#cbd5e1",
      brightBlack: "#64748b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fde047",
      brightBlue: "#7dd3fc",
      brightMagenta: "#d8b4fe",
      brightCyan: "#5eead4",
      brightWhite: "#f8fafc",
    };
  }
  return {
    background: "#fcfcfd",
    foreground: "#1f2933",
    cursor: "#111827",
    cursorAccent: "#fcfcfd",
    selectionBackground: "#bfdbfe",
    selectionInactiveBackground: "#dbeafe",
    scrollbarSliderBackground: "rgba(100, 116, 139, 0.16)",
    scrollbarSliderHoverBackground: "rgba(100, 116, 139, 0.26)",
    scrollbarSliderActiveBackground: "rgba(100, 116, 139, 0.36)",
    overviewRulerBorder: "transparent",
    black: "#1f2933",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#e2e8f0",
    brightBlack: "#64748b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#d97706",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#f8fafc",
  };
}

function terminalContainerHasSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function XTermViewport({
  client,
  session,
  theme,
  isActive,
  initialSnapshot,
  className,
  onError,
  onInitialSnapshotConsumed,
}: XTermViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  const themeRef = useRef(theme);
  const onErrorRef = useRef(onError);
  const initialSnapshotRef = useRef(initialSnapshot);
  const onInitialSnapshotConsumedRef = useRef(onInitialSnapshotConsumed);
  clientRef.current = client;
  sessionRef.current = session;
  themeRef.current = theme;
  onErrorRef.current = onError;
  onInitialSnapshotConsumedRef.current = onInitialSnapshotConsumed;

  const termRef = useRef<XTerm | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const viewportStyle = {
    "--project-terminal-background": terminalTheme(theme).background,
  } as CSSProperties;

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isActive) {
      termRef.current?.blur();
      return;
    }
    termRef.current?.focus();
    window.setTimeout(() => {
      fitAndResizeRef.current?.();
    }, 0);
  }, [isActive]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let snapshotLoaded = false;
    let loadingSnapshot = false;
    let lastOutputOffset = 0;
    const bufferedEvents: TerminalEvent[] = [];
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      disableStdin: !sessionRef.current.running,
      fontFamily:
        '"SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 5000,
      overviewRuler: {
        width: 8,
      },
      theme: terminalTheme(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    let touchScrollActive = false;
    let touchScrollCancelled = false;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchScrollRemainder = 0;

    const focusTerminal = () => {
      if (disposed || !sessionRef.current.running) return;
      term.focus();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      focusTerminal();
    };

    const fitAndResize = () => {
      if (disposed) return;
      if (!terminalContainerHasSize(container)) return;
      try {
        fit.fit();
        const s = sessionRef.current;
        void clientRef.current
          .resize(s.id, term.cols, term.rows, s.projectPathKey)
          .catch(() => undefined);
      } catch {
        // xterm fit can throw while the panel is hidden or measuring at zero size.
      }
    };
    fitAndResizeRef.current = fitAndResize;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(fitAndResize, 40);
    });
    resizeObserver.observe(container);
    window.setTimeout(fitAndResize, 0);

    const dataDisposable = term.onData((data) => {
      const s = sessionRef.current;
      if (!s.running) return;
      void clientRef.current.input(s.id, data, s.projectPathKey).catch((error) => {
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
    });

    const getTouchScrollRowHeight = () =>
      Math.max(8, Math.floor(container.clientHeight / Math.max(1, term.rows)));

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchScrollCancelled = true;
        touchScrollActive = false;
        touchScrollRemainder = 0;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      touchScrollCancelled = false;
      touchScrollActive = false;
      touchScrollRemainder = 0;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (touchScrollCancelled || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - lastTouchX;
      const deltaY = touch.clientY - lastTouchY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (!touchScrollActive) {
        if (absX > absY && absX > 8) {
          touchScrollCancelled = true;
          return;
        }
        if (absY < 8) return;
        touchScrollActive = true;
      }

      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      touchScrollRemainder += -deltaY;
      const rowHeight = getTouchScrollRowHeight();
      const rows = Math.trunc(touchScrollRemainder / rowHeight);
      if (rows !== 0) {
        term.scrollLines(rows);
        touchScrollRemainder -= rows * rowHeight;
      }
      event.preventDefault();
    };

    const resetTouchScroll = () => {
      touchScrollActive = false;
      touchScrollCancelled = false;
      touchScrollRemainder = 0;
    };

    const handleTouchEnd = () => {
      const shouldFocus = !touchScrollActive && !touchScrollCancelled;
      resetTouchScroll();
      if (shouldFocus) {
        focusTerminal();
      }
    };

    const handleTouchCancel = () => {
      resetTouchScroll();
    };

    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchCancel);

    const applySnapshot = (snapshot: TerminalSnapshot) => {
      if (snapshot.output) {
        term.write(snapshot.output);
      }
      lastOutputOffset = terminalSnapshotEndOffset(snapshot);
      snapshotLoaded = true;
      loadingSnapshot = false;
      term.options.disableStdin = !snapshot.session.running;
      replayBufferedEvents();
      window.setTimeout(fitAndResize, 0);
    };

    const replayBufferedEvents = () => {
      const events = bufferedEvents.splice(0);
      for (const event of events) {
        writeTerminalEvent(
          term,
          event,
          (nextOffset) => {
            lastOutputOffset = nextOffset;
          },
          lastOutputOffset,
        );
      }
    };

    const loadSnapshot = () => {
      if (disposed || loadingSnapshot) return;
      const initial = initialSnapshotRef.current;
      if (initial?.session.id === sessionRef.current.id) {
        initialSnapshotRef.current = undefined;
        onInitialSnapshotConsumedRef.current?.(initial.session.id);
        applySnapshot(initial);
        return;
      }
      loadingSnapshot = true;
      const s = sessionRef.current;
      void clientRef.current
        .snapshot(s.id, undefined, s.projectPathKey)
        .then((snapshot) => {
          if (disposed) return;
          applySnapshot(snapshot);
        })
        .catch((error) => {
          loadingSnapshot = false;
          if (!disposed) {
            onErrorRef.current(error instanceof Error ? error.message : String(error));
            snapshotLoaded = true;
            replayBufferedEvents();
          }
        });
    };

    const unsubscribe = clientRef.current.subscribe((event) => {
      if (disposed || event.sessionId !== session.id) return;
      if (event.kind === "output" && event.data) {
        if (snapshotLoaded && !loadingSnapshot) {
          writeTerminalEvent(
            term,
            event,
            (nextOffset) => {
              lastOutputOffset = nextOffset;
            },
            lastOutputOffset,
          );
        } else {
          bufferedEvents.push(event);
        }
      }
      if (event.kind === "exit" || event.kind === "closed" || event.kind === "reconnecting") {
        term.options.disableStdin = true;
      }
      if (event.kind === "reconnected") {
        term.options.disableStdin = false;
        window.setTimeout(fitAndResize, 0);
      }
    });

    loadSnapshot();

    return () => {
      disposed = true;
      termRef.current = null;
      fitAndResizeRef.current = null;
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      const s = sessionRef.current;
      void clientRef.current.detach(s.id, s.projectPathKey).catch(() => undefined);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.projectPathKey]);

  return (
    <div
      ref={containerRef}
      style={viewportStyle}
      className={cn(
        "project-terminal-viewport h-full min-h-0 w-full overflow-hidden",
        className,
      )}
    />
  );
}

function terminalSnapshotEndOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputEndOffset === "number" &&
    Number.isFinite(snapshot.outputEndOffset) &&
    snapshot.outputEndOffset >= 0
  ) {
    return snapshot.outputEndOffset;
  }
  const startOffset =
    typeof snapshot.outputStartOffset === "number" &&
    Number.isFinite(snapshot.outputStartOffset) &&
    snapshot.outputStartOffset >= 0
      ? snapshot.outputStartOffset
      : 0;
  return startOffset + utf8ByteLength(snapshot.output);
}

function writeTerminalEvent(
  term: XTerm,
  event: TerminalEvent,
  setLastOutputOffset: (offset: number) => void,
  lastOutputOffset: number,
): "written" | "skipped" {
  const data = event.data ?? "";
  if (!data) return "skipped";
  const startOffset = event.outputStartOffset;
  const endOffset = event.outputEndOffset;
  if (
    typeof startOffset === "number" &&
    Number.isFinite(startOffset) &&
    typeof endOffset === "number" &&
    Number.isFinite(endOffset) &&
    endOffset >= startOffset
  ) {
    if (endOffset <= lastOutputOffset) return "skipped";
    const alreadyWritten = Math.max(0, lastOutputOffset - startOffset);
    term.write(alreadyWritten > 0 ? sliceUtf8Bytes(data, alreadyWritten) : data);
    setLastOutputOffset(endOffset);
    return "written";
  }
  term.write(data);
  setLastOutputOffset(lastOutputOffset + utf8ByteLength(data));
  return "written";
}

function sliceUtf8Bytes(value: string, byteOffset: number) {
  if (byteOffset <= 0) return value;
  let consumed = 0;
  let index = 0;
  for (const segment of value) {
    const next = consumed + utf8ByteLengthOfCodePoint(segment);
    if (next <= byteOffset) {
      consumed = next;
      index += segment.length;
      continue;
    }
    if (consumed < byteOffset) {
      index += segment.length;
    }
    return value.slice(index);
  }
  return "";
}

function utf8ByteLength(value: string) {
  let length = 0;
  for (const segment of value) {
    length += utf8ByteLengthOfCodePoint(segment);
  }
  return length;
}

function utf8ByteLengthOfCodePoint(value: string) {
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
