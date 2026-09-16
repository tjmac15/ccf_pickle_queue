"use client";

import { useEffect, useState } from "react";
import { finishGame } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

export default function ScoreModal({ pending, autoRequeue, onClose }) {
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const [busy, setBusy] = useState(false);

  useEscapeKey(onClose, !!pending);

  // Pre-fill with whatever live score was already tracked on the court,
  // so opening this modal doesn't throw away points you already counted.
  useEffect(() => {
    if (pending) {
      setScoreA(pending.scoreA != null ? String(pending.scoreA) : "");
      setScoreB(pending.scoreB != null ? String(pending.scoreB) : "");
    }
  }, [pending]);

  if (!pending) return null;

  const nameFor = (id) => {
    const idx = pending.playerIds.indexOf(id);
    return idx >= 0 ? pending.playerNames[idx] : "";
  };
  const teamALabel = pending.teamA.map(nameFor).join(" & ");
  const teamBLabel = pending.teamB.map(nameFor).join(" & ");

  async function submit({ withScore, winner }) {
    setBusy(true);
    await finishGame({
      courtId: pending.courtId,
      playerIds: pending.playerIds,
      playerNames: pending.playerNames,
      teamA: pending.teamA,
      teamB: pending.teamB,
      scoreA: withScore ? Number(scoreA) : null,
      scoreB: withScore ? Number(scoreB) : null,
      winner: winner || null,
      autoRequeue,
    });
    setBusy(false);
    onClose();
  }

  const canSubmitScore =
    scoreA !== "" && scoreB !== "" && !Number.isNaN(Number(scoreA)) && !Number.isNaN(Number(scoreB));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>End the game</h3>
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
          <button
            className="btn-primary"
            disabled={busy || !canSubmitScore}
            onClick={() => submit({ withScore: true })}
          >
            Save score & end game
          </button>
        </div>

        <p className="hint" style={{ margin: "18px 0 8px" }}>
          Didn't track points? Just record who won:
        </p>
        <div className="modal-actions">
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => submit({ withScore: false, winner: "A" })}
          >
            {teamALabel || "Team A"} won
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => submit({ withScore: false, winner: "B" })}
          >
            {teamBLabel || "Team B"} won
          </button>
        </div>

        <button
          className="skip-link"
          disabled={busy}
          onClick={() => submit({ withScore: false, winner: null })}
        >
          Skip — don't record a result
        </button>
      </div>
    </div>
  );
}