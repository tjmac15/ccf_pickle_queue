"use client";

import { MODES, updateSettings } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

// "How do you want to play?" — picks how the line turns into matches.
export default function ModeModal({ open, mode, onClose }) {
  useEscapeKey(onClose, open);
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>How do you want to play?</h3>
        <div className="mode-list">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-option ${mode === m.id ? "active" : ""}`}
              onClick={() => {
                updateSettings({ mode: m.id });
                onClose();
              }}
            >
              <strong>{m.name}</strong>
              <span>{m.desc}</span>
            </button>
          ))}
          <div className="mode-option disabled">
            <strong>
              Tournament <em>coming soon</em>
            </strong>
            <span>A knockout bracket or round-robin groups, then a knockout.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
