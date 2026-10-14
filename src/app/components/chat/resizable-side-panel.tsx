'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "cf-demo-mcp-panel-width";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 260;
const MAX_WIDTH = 720;

function clamp(w: number): number {
  const viewportMax = typeof window === "undefined" ? MAX_WIDTH : Math.floor(window.innerWidth * 0.6);
  return Math.round(Math.min(Math.max(w, MIN_WIDTH), Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportMax))));
}

/**
 * Right-hand side panel whose width the user can drag from its left edge.
 * The width is remembered per browser (localStorage); double-click the handle
 * to reset it.
 */
export function ResizableSidePanel({ children, label }: { children: ReactNode; label: string }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (saved) setWidth(clamp(saved));
    } catch { /* storage unavailable — keep the default */ }
  }, []);

  const save = useCallback((w: number) => {
    try { localStorage.setItem(STORAGE_KEY, String(w)); } catch { /* ignore */ }
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel sits on the right, so dragging left makes it wider.
    setWidth(clamp(drag.current.startWidth + (drag.current.startX - e.clientX)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
    save(width);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clamp(width + (e.key === "ArrowLeft" ? 24 : -24));
    setWidth(next);
    save(next);
  };

  return (
    <div className="relative shrink-0 flex flex-col" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => { setWidth(DEFAULT_WIDTH); save(DEFAULT_WIDTH); }}
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none group focus-visible:outline-none"
      >
        <div
          className={`mx-auto h-full w-px transition-colors ${
            dragging ? "bg-primary" : "bg-transparent group-hover:bg-primary/50 group-focus-visible:bg-primary/50"
          }`}
        />
      </div>
      {/* Keep text from being selected while dragging. */}
      <div className={`flex-1 min-h-0 flex flex-col ${dragging ? "select-none" : ""}`}>{children}</div>
    </div>
  );
}
