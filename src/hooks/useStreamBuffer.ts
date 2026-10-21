// Sub-PRD 6: Subscribe to llm_token/stream_start/stream_end events
// Batch at 60fps via requestAnimationFrame

import { useEffect, useRef } from "react";
import { useStreamStore } from "../stores/streamStore";
import {
  onStreamStart,
  onStreamToken,
  onStreamEnd,
  onStreamSources,
  onStreamError,
} from "../lib/events";
import type { IntelligenceMode } from "../lib/types";

/**
 * Hook that subscribes to LLM streaming events from the Tauri backend
 * and updates the streamStore. Batches token updates at 60fps using
 * requestAnimationFrame for smooth rendering.
 */
export function useStreamBuffer() {
  const appendToken = useStreamStore((s) => s.appendToken);
  const startStream = useStreamStore((s) => s.startStream);
  const endStream = useStreamStore((s) => s.endStream);
  const setSources = useStreamStore((s) => s.setSources);
  const setError = useStreamStore((s) => s.setError);

  // Token batching buffer
  const tokenBuffer = useRef<string>("");
  const rafId = useRef<number | null>(null);
  const fallbackId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstToken = useRef(true);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];
    let mounted = true;

    const cancelFlush = () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      if (fallbackId.current !== null) clearTimeout(fallbackId.current);
      rafId.current = null;
      fallbackId.current = null;
    };

    // Flush buffered tokens to the store at ~60fps
    const flushTokens = () => {
      cancelFlush();
      if (!mounted) return;
      if (tokenBuffer.current.length > 0) {
        appendToken(tokenBuffer.current);
        tokenBuffer.current = "";
      }
    };

    // Schedule a flush if not already scheduled
    const scheduleFlush = () => {
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(flushTokens);
        // WebView can suspend animation frames when a window is occluded.
        fallbackId.current = setTimeout(flushTokens, 50);
      }
    };

    // Subscribe to stream start
    unlisteners.push(
      onStreamStart((event) => {
        if (!mounted) return;
        tokenBuffer.current = "";
        firstToken.current = true;
        cancelFlush();
        startStream(
          event.mode as IntelligenceMode,
          event.model,
          event.provider
        );
      })
    );

    // Subscribe to stream tokens — batch at 60fps
    unlisteners.push(
      onStreamToken((event) => {
        if (!mounted) return;
        tokenBuffer.current += event.token;
        // Let the user see the first words without waiting for a frame.
        if (firstToken.current) {
          firstToken.current = false;
          flushTokens();
        } else {
          scheduleFlush();
        }
      })
    );

    // Subscribe to stream end
    unlisteners.push(
      onStreamEnd((event) => {
        if (!mounted) return;
        // Flush any remaining buffered tokens immediately
        if (tokenBuffer.current.length > 0) {
          appendToken(tokenBuffer.current);
          tokenBuffer.current = "";
        }
        cancelFlush();
        endStream(event.latency_ms);
      })
    );

    // Subscribe to grounding sources (emitted before stream end, when web search is enabled)
    unlisteners.push(
      onStreamSources((event) => {
        if (!mounted) return;
        setSources(event.sources);
      })
    );

    // Subscribe to stream errors
    unlisteners.push(
      onStreamError((error) => {
        if (!mounted) return;
        tokenBuffer.current = "";
        cancelFlush();
        setError(error);
      })
    );

    // Cleanup on unmount
    return () => {
      mounted = false;
      cancelFlush();
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [appendToken, startStream, endStream, setSources, setError]);
}
