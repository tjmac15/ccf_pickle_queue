"use client";

import { useState } from "react";
import { startCustomMatch } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";
import SkillBadge from "./SkillBadge";

export default function MatchBuilderModal({ courtId, size = 4, waitingPlayers, onClose }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  useEscapeKey(onClose, !!courtId);

  if (!courtId) return null;

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= size) return prev;
      return [...prev, id];
    });
  }

  function teamOf(index) {
    if (index < size / 2) return "A";
    if (index < size) return "B";
    return null;
  }

  async function handleStart() {
    if (selected.length !== size) return;
    setBusy(true);
    const result = await startCustomMatch({
      courtId,
      teamA: selected.slice(0, size / 2),
      teamB: selected.slice(size / 2),
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
          {size === 4 ? "Tap 4 players in order — the first two become Team A, the next two Team B." : "Tap 2 players — the first is Team A, the second Team B."}
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
                disabled={!picked && selected.length >= size}
              >
                <span className="builder-name"><SkillBadge skill={p.skill} /> {p.name}</span>
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
            disabled={busy || selected.length !== size}
            onClick={handleStart}
          >
            Start match
          </button>
        </div>
      </div>
    </div>
  );
}