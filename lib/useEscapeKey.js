"use client";

import { useEffect } from "react";

export function useEscapeKey(onEscape, active) {
  useEffect(() => {
    if (!active) return;
    function handler(e) {
      if (e.key === "Escape") onEscape();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, onEscape]);
}