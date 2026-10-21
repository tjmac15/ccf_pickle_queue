"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useStore,
  flushPending,
  fillCourtIfPossible,
  adjustCourtMinutes,
  adjustLiveScore,
  addToStaging,
  autoFillStaging,
  autoFillAllStaging,
  removeFromStaging,
  reorderQueue,
  startStagedMatch,
  substitutePlayer,
  finishGame,
  endSession,
  scorePoint,
  cancelMatch,
  setCourtFormat,
  setCourtSound,
  updateSettings,
  redrawStaging,
  slotCount,
  MODES,
} from "../lib/queueLogic";

import RegisterForm from "../components/RegisterForm";
import CourtCard from "../components/CourtCard";
import UpNextCard from "../components/UpNextCard";
import QueuePanel from "../components/QueuePanel";
import Leaderboard from "../components/Leaderboard";
import SessionHistoryPanel from "../components/SessionHistoryPanel";
import ScoreModal from "../components/ScoreModal";
import SettingsPanel from "../components/SettingsPanel";
import SessionSummaryModal from "../components/SessionSummaryModal";
import MatchBuilderModal from "../components/MatchBuilderModal";
import EditPlayerModal from "../components/EditPlayerModal";
import ModeModal from "../components/ModeModal";
import LiveShareModal from "../components/LiveShareModal";
import ResultsPanel from "../components/ResultsPanel";

export default function Home() {
  // Everything comes from this device's own saved session — no database
  // reads while playing. See lib/queueLogic.js.
  const { settings, courts, players, pending, matches, broadcast } = useStore();
  const [showShare, setShowShare] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [showMode, setShowMode] = useState(false);
  const [pendingScore, setPendingScore] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [endingSession, setEndingSession] = useState(false);
  const [builderCourtId, setBuilderCourtId] = useState(null);
  const [tab, setTab] = useState("queue");

  // Upload any finished sessions that are still waiting — on page load
  // and whenever the connection comes back.
  useEffect(() => {
    flushPending();
    window.addEventListener("online", flushPending);
    return () => window.removeEventListener("online", flushPending);
  }, []);

  const waitingPlayers = useMemo(
    () =>
      players
        .filter((p) => p.status === "waiting")
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)),
    [players]
  );

  const playersById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  // Which court (if any) each waiting player is already lined up for.
  const stagedCourtByPlayer = useMemo(() => {
    const map = new Map();
    courts
      .filter((c) => c.number <= settings.courtCount)
      .forEach((c) => (c.staged || []).forEach((id) => id && !map.has(id) && map.set(id, c.number)));
    return map;
  }, [courts, settings.courtCount]);

  const playingPlayers = useMemo(
    () => players.filter((p) => p.status === "playing"),
    [players]
  );

  const visibleCourts = useMemo(() => {
    if (!settings) return courts;
    return courts.filter((c) => c.number <= settings.courtCount);
  }, [courts, settings]);

  // A player can be staged for only one court at a time. This set lets
  // each Up Next card hide players already reserved by another court.
  const stagedElsewhereIdsByCourt = useMemo(() => {
    const stagedByCourt = new Map();
    visibleCourts.forEach((court) => {
      const elsewhere = new Set();
      visibleCourts.forEach((otherCourt) => {
        if (otherCourt.id === court.id) return;
        (otherCourt.staged || []).forEach((id) => id && elsewhere.add(id));
      });
      stagedByCourt.set(court.id, elsewhere);
    });
    return stagedByCourt;
  }, [visibleCourts]);

  // Manual start: an organizer taps "Start game" on an idle court once
  // enough people are waiting. (Writes are batched and applied instantly; see lib/queueLogic.js.) Previously guarded against
  // two people tapping at the same instant on different devices.
  async function handleStartGame(courtId, stagedIds) {
    const court = courts.find((c) => c.id === courtId);
    if (stagedIds?.length === slotCount(court)) {
      await handleStartStagedMatch(courtId, stagedIds);
      return;
    }
    const result = await fillCourtIfPossible(courtId);
    if (!result.ok && result.reason === "not-enough-players") {
      alert("Need at least 4 people waiting in the queue to start a game.");
    }
    if (!result.ok && result.reason === "query-failed") {
      alert(
        "Couldn't load the queue — this usually means a Firestore index still needs to be created. Check the browser console for a link to create it."
      );
    }
  }

  async function handleStartStagedMatch(courtId, stagedIds) {
    const result = await startStagedMatch(courtId, stagedIds);
    if (!result.ok && result.reason === "court-not-idle") {
      alert("This court is still in use. Finish the current game before starting the next match.");
    } else if (!result.ok && result.reason === "player-not-waiting") {
      alert("One or more selected players are no longer waiting in the queue. Update the Up Next card and try again.");
    }
  }

  async function handleAutoFill(courtId) {
    try {
      await autoFillStaging(courtId);
    } catch (error) {
      console.error("Couldn't fill Up Next:", error);
      alert("Couldn't fill Up Next. Check your Firebase connection and try again.");
    }
  }

  // Emergency mid-game swap: replaces one player on a live court with
  // someone currently waiting, without ending the game or touching the
  // score. Whoever is on the court when the game is finished is who
  // gets credited with the game — see finishGame.
  async function handleSubstitute(courtId, outgoingPlayerId, incomingPlayerId) {
    const result = await substitutePlayer(courtId, outgoingPlayerId, incomingPlayerId);
    if (!result.ok && result.reason === "player-not-waiting") {
      alert("That player is no longer waiting in the queue. Pick someone else.");
    } else if (!result.ok) {
      alert("Couldn't make that substitution — try again.");
    }
  }

  // Reorder the queue by swapping a player up or down one spot.
  async function handleReorder(playerId, direction) {
    const ids = waitingPlayers.map((p) => p.id);
    const idx = ids.indexOf(playerId);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ids.length) return;
    const reordered = [...ids];
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
    await reorderQueue(reordered);
  }

  // One-tap win: records the winner immediately, carrying forward
  // whatever live score has been tracked on the court (0-0 if none).
  async function handleQuickWin(payload, winner) {
    await finishGame({
      ...payload,
      winner,
      autoRequeue: settings?.autoRequeue ?? true,
    });
  }

  // Reorder the whole queue at once — used by drag-and-drop, where the
  // final position (not a single up/down step) is what we know.
  async function handleReorderFull(newOrderedIds) {
    await reorderQueue(newOrderedIds);
  }

  async function handleEndSession() {
    const activeCourt = visibleCourts.find((c) => c.status === "playing");
    const confirmMsg = activeCourt
      ? "A game is still in progress — ending the session now will stop it without a recorded result. End the session anyway?"
      : "End today's open play? This clears the queue and resets stats for next time — final standings will be saved.";
    if (!window.confirm(confirmMsg)) return;

    setEndingSession(true);
    try {
      const standings = await endSession();
      setSessionSummary({
        standings,
        totalGames: Math.round(standings.reduce((sum, p) => sum + p.gamesPlayed, 0) / 4),
      });
    } catch (error) {
      console.error("Couldn't end the session:", error);
      alert("Couldn't end the session. Please try again.");
    } finally {
      setEndingSession(false);
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>CCF Open Play</h1>
            <div className="sub">Pickleball queue</div>
            <div className="stats-line">
              Courts {visibleCourts.filter((c) => c.status === "playing").length}/
              {visibleCourts.length} · Players{" "}
              {players.filter((p) => p.status === "waiting" || p.status === "playing").length} ·
              Queue {waitingPlayers.length}
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="gear-btn" onClick={handleEndSession} disabled={endingSession}>
            {endingSession ? "Ending…" : "End session"}
          </button>
          <button className="gear-btn" onClick={() => setShowShare(true)}>
            {broadcast?.on ? "Live view ●" : "Live view"}
          </button>
          <button className="gear-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      {pending.length > 0 && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(224,117,47,0.12)",
            fontSize: 13,
          }}
        >
          {pending.length} finished session{pending.length === 1 ? "" : "s"} saved on this device,
          waiting for internet to upload to History. Keep this page on this device until it clears.
        </div>
      )}

      <div className="layout">
        <div className="col">
          <RegisterForm />
          <div className="toolbar">
            <button className="chip" onClick={() => setShowMode(true)}>
              {MODES.find((m) => m.id === settings.mode)?.name || "First In, First Out"} ▾
            </button>
            <span className="chip static">
              {players.filter((p) => p.status === "waiting" || p.status === "playing").length} players ·{" "}
              {playingPlayers.length} on court · {waitingPlayers.length} waiting
            </span>
            <button className="chip primary" onClick={() => updateSettings({ courtCount: settings.courtCount + 1 })}>
              + Add court
            </button>
          </div>
          {visibleCourts.map((court) => {
            const nextPlayers = Array.from({ length: slotCount(court) }, (_, i) => i)
              .map((i) => waitingPlayers.find((player) => player.id === (court.staged || [])[i]))
              .filter(Boolean);

            return (
              <div className="court-block" key={court.id}>
              <CourtCard
                court={court}
                settings={settings}
                playersById={playersById}
                canRemove={court.number === settings.courtCount && settings.courtCount > 1 && court.status === "idle"}
                onRemoveCourt={() => updateSettings({ courtCount: settings.courtCount - 1 })}
                onScorePoint={scorePoint}
                onCancelMatch={cancelMatch}
                onSetFormat={setCourtFormat}
                onSetSound={setCourtSound}
                waitingCount={waitingPlayers.length}
                waitingPlayers={waitingPlayers}
                nextPlayers={nextPlayers}
                onEndGame={setPendingScore}
                onAdjustMinutes={adjustCourtMinutes}
                onAdjustScore={adjustLiveScore}
                onStartGame={handleStartGame}
                onChoosePlayers={setBuilderCourtId}
                onQuickWin={handleQuickWin}
                onSubstitute={handleSubstitute}
              />
              <UpNextCard
                court={court}
                waitingPlayers={waitingPlayers}
                stagedElsewhereIds={stagedElsewhereIdsByCourt.get(court.id) || new Set()}
                onAutoFill={handleAutoFill}
                onRedraw={redrawStaging}
                onRemove={removeFromStaging}
                onAdd={addToStaging}
                onStart={handleStartStagedMatch}
              />
              </div>
            );
          })}
        </div>

        <div className="col">
          <div className="panel">
            <div className="tabs">
              <button
                className={`tab-btn ${tab === "queue" ? "active" : ""}`}
                onClick={() => setTab("queue")}
              >
                Queue
              </button>
              <button
                className={`tab-btn ${tab === "results" ? "active" : ""}`}
                onClick={() => setTab("results")}
              >
                Results
              </button>
              <button
                className={`tab-btn ${tab === "leaderboard" ? "active" : ""}`}
                onClick={() => setTab("leaderboard")}
              >
                Leaderboard
              </button>
              <button
                className={`tab-btn ${tab === "history" ? "active" : ""}`}
                onClick={() => setTab("history")}
              >
                History
              </button>
            </div>
          </div>
          {tab === "queue" && (
            <QueuePanel
              waitingPlayers={waitingPlayers}
              playingPlayers={playingPlayers}
              onReorder={handleReorder}
              onReorderFull={handleReorderFull}
              onEditPlayer={setEditingPlayer}
              stagedCourtByPlayer={stagedCourtByPlayer}
            />
          )}
          {tab === "results" && <ResultsPanel matches={matches} players={players} />}
          {tab === "leaderboard" && <Leaderboard players={players} />}
          {tab === "history" && <SessionHistoryPanel pending={pending} />}
        </div>
      </div>
      
      <div className="verse-footer">
        <p>
          "So, whether you eat or drink, or play pickleball, do all to the glory of God."
        </p>
        <span>— inspired by 1 Corinthians 10:31</span>
      </div>
      
      <ScoreModal
        pending={pendingScore}
        autoRequeue={settings?.autoRequeue ?? true}
        onClose={() => setPendingScore(null)}
      />
      {showSettings && (
        <SettingsPanel settings={settings} onClose={() => setShowSettings(false)} />
      )}
      <SessionSummaryModal summary={sessionSummary} onClose={() => setSessionSummary(null)} />
      <EditPlayerModal player={editingPlayer} onClose={() => setEditingPlayer(null)} />
      <LiveShareModal open={showShare} broadcast={broadcast || { on: false }} onClose={() => setShowShare(false)} />
      <ModeModal open={showMode} mode={settings.mode} onClose={() => setShowMode(false)} />
      <MatchBuilderModal
        courtId={builderCourtId}
        size={slotCount(courts.find((c) => c.id === builderCourtId))}
        waitingPlayers={waitingPlayers}
        onClose={() => setBuilderCourtId(null)}
      />
    </div>
  );
}
