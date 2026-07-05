import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import iconSimpleUrl from "../../../../src-tauri/icons/icon-simple.png";
import { Copy, Settings } from "../../../components/icons";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { useLocale } from "../../../i18n";
import { resolveScrollViewport } from "../utils/chatScrollViewport";
import { TranscriptHistory } from "./TranscriptHistory";
import { TranscriptLiveState } from "./TranscriptLiveState";
import { HistorySwitchLoadingOverlay } from "./TranscriptLoadingStates";
import type { ChatTranscriptProps } from "./transcriptTypes";
import {
  clampTranscriptContextMenuPosition,
  resolveTranscriptSelectionText,
  type TranscriptContextMenuState,
  writeTextToClipboard,
} from "./transcriptUtils";

export type { ChatTranscriptProps } from "./transcriptTypes";

export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  const {
    conversationId,
    workspaceRoot,
    gitClient,
    scrollAreaRef,
    bottomRef,
    hasModels,
    historyItems,
    isHistorySwitching,
    isSending,
    isAgentMode,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
    bottomReservePx = 0,
    copiedMessageKey,
    setCopiedMessageKey,
    onResendFromEdit,
    onOpenSettings,
  } = props;
  const { t, locale } = useLocale();
  const showNoModelsState = !hasModels;
  const showStartChatState = hasModels && historyItems.length === 0 && !isSending;
  const shouldReserveTranscriptBottomSpace = !(showNoModelsState || showStartChatState);
  const transcriptBottomReservePx = shouldReserveTranscriptBottomSpace
    ? Math.max(192, Math.ceil(bottomReservePx) + 12)
    : 0;
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  const transcriptContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [transcriptContextMenu, setTranscriptContextMenu] =
    useState<TranscriptContextMenuState | null>(null);

  const closeTranscriptContextMenu = useCallback(() => {
    setTranscriptContextMenu(null);
  }, []);

  useLayoutEffect(() => {
    const nextViewport = resolveScrollViewport(scrollAreaRef.current);
    if (scrollViewport !== nextViewport) {
      setScrollViewport(nextViewport);
    }
  }, [scrollAreaRef, scrollViewport]);

  useEffect(() => {
    closeTranscriptContextMenu();
  }, [closeTranscriptContextMenu, conversationId]);

  useEffect(() => {
    if (!transcriptContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeTranscriptContextMenu();
        return;
      }
      if (transcriptContextMenuRef.current?.contains(target)) {
        return;
      }
      closeTranscriptContextMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTranscriptContextMenu();
      }
    };

    const handleSelectionChange = () => {
      if (!resolveTranscriptSelectionText(transcriptRootRef.current)) {
        closeTranscriptContextMenu();
      }
    };

    const handleScroll = () => {
      closeTranscriptContextMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("blur", handleScroll);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("blur", handleScroll);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [closeTranscriptContextMenu, transcriptContextMenu]);

  const handleTranscriptContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const selectedText = resolveTranscriptSelectionText(transcriptRootRef.current);
      if (!selectedText) {
        closeTranscriptContextMenu();
        return;
      }
      setTranscriptContextMenu({
        x: event.clientX,
        y: event.clientY,
        selectedText,
      });
    },
    [closeTranscriptContextMenu],
  );

  const transcriptContextMenuPosition = transcriptContextMenu
    ? clampTranscriptContextMenuPosition(transcriptContextMenu.x, transcriptContextMenu.y)
    : null;
  const copySelectedTextLabel = locale === "en-US" ? "Copy selected text" : "复制选中文本";

  return (
    <div
      ref={transcriptRootRef}
      className="relative min-h-0 flex-1"
      onContextMenu={handleTranscriptContextMenu}
    >
      <ScrollArea ref={scrollAreaRef} className="h-full">
        <div className="mx-auto w-full max-w-[768px] px-5 py-4">
          {showNoModelsState ? (
            <div className="flex min-h-[calc(100vh-220px)] flex-col items-center justify-center">
              <div className="relative flex flex-col items-center">
                <div className="hero-entrance hero-icon-float mb-5 flex h-24 w-24 items-center justify-center">
                  <img
                    src={iconSimpleUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="h-[72px] w-[72px] select-none object-contain"
                  />
                </div>
                <h2 className="hero-entrance-delay-1 mb-2 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-2xl font-semibold leading-tight tracking-tight text-transparent">
                  {t("chat.welcome")}
                </h2>
                <p className="hero-entrance-delay-2 mb-1 text-sm text-muted-foreground">
                  {t("chat.noModelSelected")}
                </p>
                <p className="hero-entrance-delay-2 mb-7 text-sm text-muted-foreground">
                  {t("chat.configureModel")}
                </p>
                <button
                  type="button"
                  onClick={() => onOpenSettings("providers")}
                  className="hero-entrance-delay-3 group inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/65 px-5 py-2 text-sm font-medium text-foreground/85 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/80 hover:text-foreground hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] active:translate-y-0 active:shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-foreground/90 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),0_8px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.1]"
                >
                  <Settings className="h-3.5 w-3.5 text-foreground/55 transition-colors group-hover:text-foreground/80" />
                  {t("chat.goToSettings")}
                </button>
              </div>
            </div>
          ) : showStartChatState ? (
            <div className="flex min-h-[calc(100vh-220px)] flex-col items-center justify-center">
              <div className="relative flex flex-col items-center">
                <div className="hero-entrance hero-icon-float mb-5 flex h-24 w-24 items-center justify-center">
                  <img
                    src={iconSimpleUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="h-[72px] w-[72px] select-none object-contain"
                  />
                </div>

                <h2 className="hero-entrance-delay-1 mb-2 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-2xl font-semibold leading-tight tracking-tight text-transparent">
                  {t("chat.startChat")}
                </h2>

                <p className="hero-entrance-delay-2 max-w-[280px] text-center text-sm leading-relaxed text-muted-foreground">
                  {t("chat.startChatDesc")}
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-6 select-text">
            <TranscriptHistory
              conversationId={conversationId}
              workspaceRoot={workspaceRoot}
              gitClient={gitClient}
              scrollViewport={scrollViewport}
              historyItems={historyItems}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              copiedMessageKey={copiedMessageKey}
              setCopiedMessageKey={setCopiedMessageKey}
              onResendFromEdit={onResendFromEdit}
              isSending={isSending}
            />

            <TranscriptLiveState
              isSending={isSending}
              isAgentMode={isAgentMode}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              liveTranscriptStore={liveTranscriptStore}
              isCompactionRunning={isCompactionRunning}
            />
          </div>

          <div ref={bottomRef} style={{ height: transcriptBottomReservePx }} />
        </div>
      </ScrollArea>
      {transcriptContextMenu && transcriptContextMenuPosition
        ? createPortal(
            <div
              ref={transcriptContextMenuRef}
              role="menu"
              className="fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]"
              style={{
                left: transcriptContextMenuPosition.left,
                top: transcriptContextMenuPosition.top,
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  writeTextToClipboard(transcriptContextMenu.selectedText);
                  closeTranscriptContextMenu();
                }}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{copySelectedTextLabel}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {isHistorySwitching ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
});
