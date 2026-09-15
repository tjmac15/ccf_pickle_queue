"use client";

import { useState } from "react";
import { startCustomMatch } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

export default function MatchBuilderModal({ courtId, waitingPlayers, onClose }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  useEscapeKey(onClose, !!courtId);

  if (!courtId) return null;

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  }

  function teamOf(index) {
    if (index === 0 || index === 1) return "A";
    if (index === 2 || index === 3) return "B";
    return null;
  }

  async function handleStart() {
    if (selected.length !== 4) return;
    setBusy(true);
    const result = await startCustomMatch({
      courtId,
      teamA: selected.slice(0, 2),
      teamB: selected.slice(2, 4),
    });
    setBusy(false);
    if (!result.ok) {
      alert("Couldn't start that match — one of the selected players may have already moved. Try again.");
      return;
    }
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Choose players</h3>
        <p className="hint">
          Tap 4 players in order — the first two become Team A, the next two Team B.
        </p>

        <div className="builder-list">
          {waitingPlayers.map((p) => {
            const idx = selected.indexOf(p.id);
            const picked = idx !== -1;
            return (
              <button
                key={p.id}
                className={`builder-row ${picked ? "picked" : ""}`}
                onClick={() => toggle(p.id)}
                disabled={!picked && selected.length >= 4}
              >
                <span className="builder-name">{p.name}</span>
                {picked && <span className={`builder-tag team-${teamOf(idx)}`}>Team {teamOf(idx)}</span>}
              </button>
            );
          })}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={() => setSelected([])} disabled={busy}>
            Clear
          </button>
          <button
            className="btn-primary"
            disabled={busy || selected.length !== 4}
            onClick={handleStart}
          >
            Start match
          </button>
        </div>
      </div>
    </div>
  );
}