"use client";

import { useEffect, useState } from "react";

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function CourtCard({ court, onEndGame, onAdjustMinutes }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (court.status !== "playing") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [court.status]);

  const isPlaying = court.status === "playing";
  const gameSeconds = (court.gameMinutes || 10) * 60;
  const startMs = court.startTime ? court.startTime.getTime() : now;
  const remaining = isPlaying ? gameSeconds - (now - startMs) / 1000 : gameSeconds;
  const timeUp = isPlaying && remaining <= 0;

  const names = court.playerNames || [];
  const ids = court.playerIds || [];
  const teamAName = [names[0], names[1]].filter(Boolean);
  const teamBName = [names[2], names[3]].filter(Boolean);
  const teamAIds = [ids[0], ids[1]].filter(Boolean);
  const teamBIds = [ids[2], ids[3]].filter(Boolean);

  return (
    <div className="court-card">
      <div className="court-head">
        <div>
          <div className="court-label">Court</div>
          <div className="court-number">{court.number}</div>
        </div>
        <span className={`court-status-pill ${isPlaying ? "playing" : ""}`}>
          {isPlaying ? (timeUp ? "Time's up" : "In play") : "Open"}
        </span>
      </div>

      {!isPlaying && (
        <>
          <div className="court-idle-msg">
            Waiting for the next group of four from the queue.
          </div>
          <div className="mini-stepper-row">
            <span>Next game: {court.gameMinutes || 10} min</span>
            <div className="mini-stepper">
              <button onClick={() => onAdjustMinutes(court.id, -1)} aria-label="Decrease minutes">
                −
              </button>
              <button onClick={() => onAdjustMinutes(court.id, 1)} aria-label="Increase minutes">
                +
              </button>
            </div>
          </div>
        </>
      )}

      {isPlaying && (
        <>
          <div className="court-teams">
            <div className="team">
              <div className="team-label">Team A</div>
              <div className="team-names">{teamAName.join(" & ")}</div>
            </div>
            <span className="vs">vs</span>
            <div className="team">
              <div className="team-label">Team B</div>
              <div className="team-names">{teamBName.join(" & ")}</div>
            </div>
          </div>

          <div className="timer-row">
            <div className={`timer ${timeUp ? "urgent" : ""}`}>
              {timeUp ? "0:00" : formatClock(remaining)}
            </div>
            <div className="mini-stepper">
              <button onClick={() => onAdjustMinutes(court.id, -1)} aria-label="Subtract a minute">
                −1 min
              </button>
              <button onClick={() => onAdjustMinutes(court.id, 1)} aria-label="Add a minute">
                +1 min
              </button>
            </div>
          </div>

          <div className="court-actions">
            <button
              className={`btn-ghost-light ${timeUp ? "strong" : ""}`}
              onClick={() =>
                onEndGame({
                  courtId: court.id,
                  playerIds: ids,
                  playerNames: names,
                  teamA: teamAIds,
                  teamB: teamBIds,
                })
              }
            >
              {timeUp ? "Enter score & end game" : "End game early"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
