"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import {
  ensureSettingsExist,
  ensureCourtsExist,
  fillCourtIfPossible,
  adjustCourtMinutes,
  adjustLiveScore,
  addToStaging,
  autoFillStaging,
  removeFromStaging,
  reorderQueue,
  startStagedMatch,
  finishGame,
  endSession,
  DEFAULT_SETTINGS,
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

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [courts, setCourts] = useState([]);
  const [players, setPlayers] = useState([]);
  const [pendingScore, setPendingScore] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [endingSession, setEndingSession] = useState(false);
  const [builderCourtId, setBuilderCourtId] = useState(null);
  const [tab, setTab] = useState("queue");
  const [ready, setReady] = useState(false);

  // Bootstrap: make sure config + court docs exist on first-ever load.
  useEffect(() => {
    (async () => {
      await ensureSettingsExist();
      await ensureCourtsExist(DEFAULT_SETTINGS.courtCount);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const unsub = onSnapshot(doc(db, "config", "settings"), (snap) => {
      if (snap.exists()) setSettings(snap.data());
    });
    return unsub;
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const q = query(collection(db, "courts"), orderBy("number", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: "estimate" });
        return {
          id: d.id,
          ...data,
          startTime: data.startTime ? data.startTime.toDate() : null,
        };
      });
      setCourts(list);
    });
    return unsub;
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const unsub = onSnapshot(collection(db, "players"), (snap) => {
      const list = snap.docs.map((d) => ({
        id: d.id,
        ...d.data({ serverTimestamps: "estimate" }),
      }));
      setPlayers(list);
    });
    return unsub;
  }, [ready]);

  const waitingPlayers = useMemo(
    () =>
      players
        .filter((p) => p.status === "waiting")
        .sort((a, b) => (a.joinedAt?.toMillis() || 0) - (b.joinedAt?.toMillis() || 0)),
    [players]
  );

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
        (otherCourt.staged || []).forEach((id) => elsewhere.add(id));
      });
      stagedByCourt.set(court.id, elsewhere);
    });
    return stagedByCourt;
  }, [visibleCourts]);

  // Manual start: an organizer taps "Start game" on an idle court once
  // enough people are waiting. The transaction still protects against
  // two people tapping at the same instant on different devices.
  async function handleStartGame(courtId) {
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
    const standings = await endSession();
    setEndingSession(false);
    setSessionSummary({
      standings,
      totalGames: Math.round(standings.reduce((sum, p) => sum + p.gamesPlayed, 0) / 4),
    });
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
          <button className="gear-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      <div className="layout">
        <div className="col">
          <RegisterForm />
          {visibleCourts.map((court) => (
            <div className="court-block" key={court.id}>
              <CourtCard
                court={court}
                waitingCount={waitingPlayers.length}
                onEndGame={setPendingScore}
                onAdjustMinutes={adjustCourtMinutes}
                onAdjustScore={adjustLiveScore}
                onStartGame={handleStartGame}
                onChoosePlayers={setBuilderCourtId}
                onQuickWin={handleQuickWin}
              />
              <UpNextCard
                court={court}
                waitingPlayers={waitingPlayers}
                stagedElsewhereIds={stagedElsewhereIdsByCourt.get(court.id) || new Set()}
                onAutoFill={autoFillStaging}
                onRemove={removeFromStaging}
                onAdd={addToStaging}
                onStart={handleStartStagedMatch}
              />
            </div>
          ))}
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
            />
          )}
          {tab === "leaderboard" && <Leaderboard players={players} />}
          {tab === "history" && <SessionHistoryPanel />}
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
      <MatchBuilderModal
        courtId={builderCourtId}
        waitingPlayers={waitingPlayers}
        onClose={() => setBuilderCourtId(null)}
      />
    </div>
  );
}
