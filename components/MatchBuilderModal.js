"use client";

import { useState } from "react";
import { startCustomMatch } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

const VALID_SIZES = [2, 4];

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

  // Splits evenly by however many are selected: 2 -> 1v1 singles,
  // 4 -> 2v2 doubles. Not enough players for doubles? Just pick 2
  // and start a singles match instead.
  const half = Math.ceil(selected.length / 2);
  function teamOf(index) {
    if (selected.length < 2) return null;
    return index < half ? "A" : "B";
  }

  const isValidCount = VALID_SIZES.includes(selected.length);

  async function handleStart() {
    if (!isValidCount) return;
    setBusy(true);
    const result = await startCustomMatch({
      courtId,
      teamA: selected.slice(0, half),
      teamB: selected.slice(half),
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
          Tap 2 players for a 1v1 match, or 4 for doubles — the first half become Team A, the
          rest Team B.
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
                <span className="builder-games">
                  {p.gamesPlayed || 0} game{(p.gamesPlayed || 0) === 1 ? "" : "s"} played
                </span>
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
            disabled={busy || !isValidCount}
            onClick={handleStart}
          >
            {selected.length === 2 ? "Start 1v1 match" : "Start match"}
          </button>
        </div>
      </div>
    </div>
  );
}
