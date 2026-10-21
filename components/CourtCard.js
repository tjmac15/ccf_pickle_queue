"use client";

import { useEffect, useRef, useState } from "react";
import SkillBadge from "./SkillBadge";

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Short beep when time runs out (no audio file needed).
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.25, 0.5].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.15);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

export default function CourtCard({
  court,
  settings,
  playersById,
  waitingCount,
  waitingPlayers = [],
  nextPlayers = [],
  canRemove,
  onEndGame,
  onAdjustMinutes,
  onStartGame,
  onChoosePlayers,
  onQuickWin,
  onAdjustScore,
  onScorePoint,
  onSubstitute,
  onCancelMatch,
  onSetFormat,
  onSetSound,
  onRemoveCourt,
}) {
  const [now, setNow] = useState(Date.now());
  const [swappingId, setSwappingId] = useState(null);
  const cardRef = useRef(null);
  const beeped = useRef(false);

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
  const singles = court.format === "singles";
  const gameSeconds = (court.gameMinutes || 10) * 60;
  const startMs = court.startTime || now;
  const remaining = isPlaying ? gameSeconds - (now - startMs) / 1000 : gameSeconds;
  const timeUp = isPlaying && remaining <= 0;

  useEffect(() => {
    if (!isPlaying) beeped.current = false;
    else if (timeUp && !beeped.current) {
      beeped.current = true;
      if (court.sound !== false) beep();
    }
  }, [isPlaying, timeUp, court.sound]);

  const names = court.playerNames || [];
  const ids = court.playerIds || [];
  const half = Math.ceil(ids.length / 2) || (singles ? 1 : 2);
  const teamAIds = ids.slice(0, half);
  const teamBIds = ids.slice(half);
  const teamANames = names.slice(0, half);
  const teamBNames = names.slice(half);
  const teamARows = teamAIds.map((id, i) => ({ id, name: teamANames[i] }));
  const teamBRows = teamBIds.map((id, i) => ({ id, name: teamBNames[i] }));

  const skillSum = (list) => list.reduce((t, id) => t + (playersById.get(id)?.skill || 3), 0);
  const skillA = skillSum(teamAIds);
  const skillB = skillSum(teamBIds);

  const scoreA = court.liveScoreA || 0;
  const scoreB = court.liveScoreB || 0;
  const target = settings.pointsToWin || 11;
  const reached = Math.max(scoreA, scoreB) >= target;
  const gameOver = reached && (!settings.winByTwo || Math.abs(scoreA - scoreB) >= 2);
  const leader = scoreA > scoreB ? "A" : "B";

  const serving = court.servingTeam || "A";
  const serveScore = serving === "A" ? scoreA : scoreB;
  const receiveScore = serving === "A" ? scoreB : scoreA;
  const callText = singles
    ? `${serveScore}-${receiveScore}`
    : `${serveScore}-${receiveScore}-${court.serverNum || 2}`;

  const payload = {
    courtId: court.id,
    playerIds: ids,
    playerNames: names,
    teamA: teamAIds,
    teamB: teamBIds,
    scoreA,
    scoreB,
  };

  const need = (singles ? 2 : 4) - nextPlayers.length;

  function fullscreen() {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }

  function renderScoreControl(team) {
    const isServing = serving === team;
    const value = team === "A" ? scoreA : scoreB;
    const showSideOut = settings.trackServe && !isServing;
    return (
      <div className="live-score-team">
        <button disabled={!(value > 0)} onClick={() => onAdjustScore(court.id, team, -1)} aria-label={`Decrease Team ${team} score`}>
          −
        </button>
        <span className="live-score-value">{value}</span>
        {showSideOut ? (
          <button className="sideout-btn" onClick={() => onScorePoint(court.id, team)} title="They won the rally — side out" aria-label={`Team ${team} won the rally (side out)`}>
            ↻
          </button>
        ) : (
          <button onClick={() => onScorePoint(court.id, team)} aria-label={`Increase Team ${team} score`}>
            +
          </button>
        )}
        {settings.trackServe && (
          <span className={`serve-pill ${isServing ? "serving" : ""}`}>
            {isServing ? (singles ? "Serving" : `Serving · ${court.serverNum || 2}`) : "Receiving"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="court-card" ref={cardRef}>
      <div className="court-head">
        <div>
          <div className="court-label">Court</div>
          <div className="court-number">{court.number}</div>
        </div>
        <div className="court-head-right">
          <button className="court-icon-btn" onClick={() => onSetSound(court.id, court.sound === false)} title="Sound when time is up" aria-label="Toggle sound">
            {court.sound === false ? "🔇" : "🔊"}
          </button>
          <button className="court-icon-btn" onClick={fullscreen} title="Full screen scoreboard" aria-label="Full screen">
            ⛶
          </button>
          <span className={`court-status-pill ${isPlaying ? "playing" : ""}`}>
            {isPlaying ? (timeUp ? "Time's up" : "In play") : "Open"}
          </span>
        </div>
      </div>

      <div className="court-sub">
        Pickleball · {singles ? "Singles" : "Doubles"}
        {!isPlaying && (
          <select className="court-format" value={court.format || "doubles"} onChange={(e) => onSetFormat(court.id, e.target.value)}>
            <option value="doubles">Doubles</option>
            <option value="singles">Singles</option>
          </select>
        )}
      </div>

      {!isPlaying && (
        <>
          <div className="court-idle-msg">
            {need <= 0
              ? "Ready — your next match is selected below."
              : `Select ${need} more player${need === 1 ? "" : "s"} for this court.`}
          </div>
          {nextPlayers.length > 0 && (
            <div className="court-next-lineup">
              <div className="court-next-label">Next players</div>
              <div className="court-next-players">
                {nextPlayers.map((player) => (
                  <span key={player.id}>
                    <SkillBadge skill={player.skill} /> {player.name}
                  </span>
                ))}
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
              disabled={need > 0}
              onClick={() => onStartGame(court.id, nextPlayers.map((player) => player.id))}
            >
              Start game
            </button>
            <button className="btn-ghost-light" disabled={waitingCount < 2} onClick={() => onChoosePlayers(court.id)}>
              Choose players
            </button>
            {canRemove && (
              <button className="btn-ghost-light" onClick={() => onRemoveCourt(court.id)}>
                Remove court
              </button>
            )}
          </div>
        </>
      )}

      {isPlaying && (
        <>
          <div className="court-teams">
            <div className="team team-a">
              <div className="team-label">Team A</div>
              {teamARows.map((player) => (
                <PlayerRow key={player.id} player={player} skill={playersById.get(player.id)?.skill} court={court} waitingPlayers={waitingPlayers} swappingId={swappingId} setSwappingId={setSwappingId} onSubstitute={onSubstitute} />
              ))}
            </div>
            <span className="vs">vs</span>
            <div className="team team-b">
              <div className="team-label">Team B</div>
              {teamBRows.map((player) => (
                <PlayerRow key={player.id} player={player} skill={playersById.get(player.id)?.skill} court={court} waitingPlayers={waitingPlayers} swappingId={swappingId} setSwappingId={setSwappingId} onSubstitute={onSubstitute} />
              ))}
            </div>
          </div>

          <div className="live-score-row">
            {renderScoreControl("A")}
            <span className="live-score-label">score</span>
            {renderScoreControl("B")}
          </div>

          <div className="call-line">
            Skill {skillA} vs {skillB}
            {settings.trackServe && <> · Call: {callText}{!singles && " (serving side first)"}</>}
          </div>

          {gameOver && (
            <div className="gameover-banner">
              Game over — Team {leader} reached {Math.max(scoreA, scoreB)}. Tap their name below to save.
            </div>
          )}

          <div className="timer-row">
            <div className={`timer ${timeUp ? "urgent" : ""}`}>{timeUp ? "0:00" : formatClock(remaining)}</div>
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
            <button className={`quick-win-btn team-a ${gameOver && leader === "A" ? "suggested" : ""}`} onClick={() => onQuickWin(payload, "A")}>
              {teamANames.join(" & ") || "Team A"} Wins
            </button>
            <button className={`quick-win-btn team-b ${gameOver && leader === "B" ? "suggested" : ""}`} onClick={() => onQuickWin(payload, "B")}>
              {teamBNames.join(" & ") || "Team B"} Wins
            </button>
          </div>

          <div className="court-foot-links">
            <button className="enter-score-link" onClick={() => onEndGame(payload)}>
              Enter exact score instead
            </button>
            <button
              className="enter-score-link"
              onClick={() => {
                if (window.confirm("Cancel this match? Nothing is recorded and everyone goes back to the front of the line.")) onCancelMatch(court.id);
              }}
            >
              Cancel match
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// One player's row inside a live team box: skill badge, name, and a ⇄
// button that opens an inline picker of waiting players to swap in.
function PlayerRow({ player, skill, court, waitingPlayers, swappingId, setSwappingId, onSubstitute }) {
  const isSwapping = swappingId === player.id;

  return (
    <div className="court-player-row">
      <SkillBadge skill={skill} />
      <span className="court-player-name">{player.name}</span>
      {!isSwapping && (
        <button className="court-swap-btn" onClick={() => setSwappingId(player.id)} aria-label={`Substitute for ${player.name}`} title="Substitute this player">
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
