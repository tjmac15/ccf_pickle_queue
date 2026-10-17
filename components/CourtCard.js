"use client";

import { useEffect, useState } from "react";

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function CourtCard({ court, waitingCount, waitingPlayers = [], nextPlayers = [], onEndGame, onAdjustMinutes, onStartGame, onChoosePlayers, onQuickWin, onAdjustScore, onSubstitute }) {
  const [now, setNow] = useState(Date.now());
  const [swappingId, setSwappingId] = useState(null);

  useEffect(() => {
    if (court.status !== "playing") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [court.status]);

  // Close any open swap picker if the court stops playing, or if the
  // roster changes out from under it (e.g. the swap just completed).
  useEffect(() => {
    setSwappingId(null);
  }, [court.status, court.playerIds]);

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

  const teamARows = teamAIds.map((id, i) => ({ id, name: teamAName[i] }));
  const teamBRows = teamBIds.map((id, i) => ({ id, name: teamBName[i] }));

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
            {nextPlayers.length === 4
              ? "Ready — your next match is selected below."
              : `Select ${4 - nextPlayers.length} more player${4 - nextPlayers.length === 1 ? "" : "s"} for this court.`}
          </div>
          {nextPlayers.length > 0 && (
            <div className="court-next-lineup">
              <div className="court-next-label">Next players</div>
              <div className="court-next-players">
                {nextPlayers.map((player) => <span key={player.id}>{player.name}</span>)}
              </div>
            </div>
          )}
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
          <div className="court-actions">
            <button
              className="btn-ghost-light strong"
              disabled={nextPlayers.length < 4}
              onClick={() => onStartGame(court.id, nextPlayers.map((player) => player.id))}
            >
              Start game
            </button>
            <button
              className="btn-ghost-light"
              disabled={waitingCount < 2}
              onClick={() => onChoosePlayers(court.id)}
            >
              Choose players
            </button>
          </div>
        </>
      )}

      {isPlaying && (
        <>
          <div className="court-teams">
            <div className="team team-a">
              <div className="team-label">Team A</div>
              {teamARows.map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  court={court}
                  waitingPlayers={waitingPlayers}
                  swappingId={swappingId}
                  setSwappingId={setSwappingId}
                  onSubstitute={onSubstitute}
                />
              ))}
            </div>
            <span className="vs">vs</span>
            <div className="team team-b">
              <div className="team-label">Team B</div>
              {teamBRows.map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  court={court}
                  waitingPlayers={waitingPlayers}
                  swappingId={swappingId}
                  setSwappingId={setSwappingId}
                  onSubstitute={onSubstitute}
                />
              ))}
            </div>
          </div>

          <div className="live-score-row">
            <div className="live-score-team">
              <button disabled={!(court.liveScoreA > 0)} onClick={() => onAdjustScore(court.id, "A", -1)} aria-label="Decrease Team A score">
                −
              </button>
              <span className="live-score-value">{court.liveScoreA || 0}</span>
              <button onClick={() => onAdjustScore(court.id, "A", 1)} aria-label="Increase Team A score">
                +
              </button>
            </div>
            <span className="live-score-label">score</span>
            <div className="live-score-team">
              <button disabled={!(court.liveScoreB > 0)} onClick={() => onAdjustScore(court.id, "B", -1)} aria-label="Decrease Team B score">
                −
              </button>
              <span className="live-score-value">{court.liveScoreB || 0}</span>
              <button onClick={() => onAdjustScore(court.id, "B", 1)} aria-label="Increase Team B score">
                +
              </button>
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

          <div className="quick-win-row">
            <button
              className="quick-win-btn team-a"
              onClick={() =>
                onQuickWin(
                  {
                    courtId: court.id,
                    playerIds: ids,
                    playerNames: names,
                    teamA: teamAIds,
                    teamB: teamBIds,
                    scoreA: court.liveScoreA || 0,
                    scoreB: court.liveScoreB || 0,
                  },
                  "A"
                )
              }
            >
              {teamAName.join(" & ") || "Team A"} Wins
            </button>
            <button
              className="quick-win-btn team-b"
              onClick={() =>
                onQuickWin(
                  {
                    courtId: court.id,
                    playerIds: ids,
                    playerNames: names,
                    teamA: teamAIds,
                    teamB: teamBIds,
                    scoreA: court.liveScoreA || 0,
                    scoreB: court.liveScoreB || 0,
                  },
                  "B"
                )
              }
            >
              {teamBName.join(" & ") || "Team B"} Wins
            </button>
          </div>

          <button
            className="enter-score-link"
            onClick={() =>
              onEndGame({
                courtId: court.id,
                playerIds: ids,
                playerNames: names,
                teamA: teamAIds,
                teamB: teamBIds,
                scoreA: court.liveScoreA || 0,
                scoreB: court.liveScoreB || 0,
              })
            }
          >
            Enter exact score instead
          </button>
        </>
      )}
    </div>
  );
}

// One player's row inside a live team box: their name, plus a ⇄ button
// that opens an inline picker of currently-waiting players to swap in.
// For emergencies — an injury, someone has to leave, a walk-in taking
// an open spot — without ending the game or touching the score.
function PlayerRow({ player, court, waitingPlayers, swappingId, setSwappingId, onSubstitute }) {
  const isSwapping = swappingId === player.id;

  return (
    <div className="court-player-row">
      <span className="court-player-name">{player.name}</span>
      {!isSwapping && (
        <button
          className="court-swap-btn"
          onClick={() => setSwappingId(player.id)}
          aria-label={`Substitute for ${player.name}`}
          title="Substitute this player"
        >
          ⇄
        </button>
      )}
      {isSwapping && (
        <select
          className="court-swap-select"
          autoFocus
          defaultValue=""
          onChange={(e) => {
            const incomingId = e.target.value;
            setSwappingId(null);
            if (incomingId) onSubstitute(court.id, player.id, incomingId);
          }}
          onBlur={() => setSwappingId(null)}
        >
          <option value="" disabled>
            Swap in…
          </option>
          {waitingPlayers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
