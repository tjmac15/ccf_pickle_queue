"use client";

import { useState } from "react";
import { finishGame } from "../lib/queueLogic";

export default function ScoreModal({ pending, autoRequeue, onClose }) {
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const [busy, setBusy] = useState(false);

  if (!pending) return null;

  const nameFor = (id) => {
    const idx = pending.playerIds.indexOf(id);
    return idx >= 0 ? pending.playerNames[idx] : "";
  };
  const teamALabel = pending.teamA.map(nameFor).join(" & ");
  const teamBLabel = pending.teamB.map(nameFor).join(" & ");

  async function submit(withScore) {
    setBusy(true);
    await finishGame({
      courtId: pending.courtId,
      playerIds: pending.playerIds,
      playerNames: pending.playerNames,
      teamA: pending.teamA,
      teamB: pending.teamB,
      scoreA: withScore ? Number(scoreA) : null,
      scoreB: withScore ? Number(scoreB) : null,
      autoRequeue,
    });
    setBusy(false);
    onClose();
  }

  const canSubmitScore = scoreA !== "" && scoreB !== "" && !Number.isNaN(Number(scoreA)) && !Number.isNaN(Number(scoreB));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Enter the score</h3>
        <p className="hint">
          {autoRequeue
            ? "These four go back to the end of the queue once you save."
            : "Players won't be re-queued automatically — add them to the queue again when they're ready."}
        </p>

        <div className="score-row">
          <span className="team-tag">{teamALabel}</span>
          <input
            type="number"
            inputMode="numeric"
            value={scoreA}
            onChange={(e) => setScoreA(e.target.value)}
            placeholder="0"
          />
        </div>
        <div className="score-row">
          <span className="team-tag">{teamBLabel}</span>
          <input
            type="number"
            inputMode="numeric"
            value={scoreB}
            onChange={(e) => setScoreB(e.target.value)}
            placeholder="0"
          />
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" disabled={busy} onClick={() => submit(false)}>
            Skip score
          </button>
          <button
            className="btn-primary"
            disabled={busy || !canSubmitScore}
            onClick={() => submit(true)}
          >
            Save & end game
          </button>
        </div>
      </div>
    </div>
  );
}
