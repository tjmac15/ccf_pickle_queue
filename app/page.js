"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  autoFillAllStaging,
  removeFromStaging,
  reorderQueue,
  startStagedMatch,
  substitutePlayer,
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
  // Which listeners have delivered data, and whether it came from the
  // network (fresh) or only the on-device cache (possibly stale).
  const [loaded, setLoaded] = useState({ settings: false, courts: false, players: false });
  const [fresh, setFresh] = useState({ settings: false, courts: false, players: false });
  const autoFillInProgress = useRef(false);
  const bootstrapped = useRef({ settings: false, courts: false });

  function markLoaded(key, snap) {
    setLoaded((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    if (!snap.metadata.fromCache) setFresh((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }

  // Listeners attach immediately on page load — they no longer wait for a
  // "make sure the docs exist" round-trip to the server. On a slow
  // connection that wait was what left every list blank; now whatever is
  // in the on-device cache paints right away and live data replaces it.
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "config", "settings"),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.exists()) setSettings(snap.data());
        markLoaded("settings", snap);
        // Only create the settings doc after the SERVER confirms it's missing.
        if (!snap.metadata.fromCache && !snap.exists() && !bootstrapped.current.settings) {
          bootstrapped.current.settings = true;
          ensureSettingsExist().catch((e) => console.error(e));
        }
      }
    );
    return unsub;
  }, []);

  useEffect(() => {
    const q = query(collection(db, "courts"), orderBy("number", "asc"));
    const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: "estimate" });
        return {
          id: d.id,
          ...data,
          startTime: data.startTime ? data.startTime.toDate() : null,
        };
      });
      setCourts(list);
      markLoaded("courts", snap);
      if (!snap.metadata.fromCache && snap.empty && !bootstrapped.current.courts) {
        bootstrapped.current.courts = true;
        ensureCourtsExist(DEFAULT_SETTINGS.courtCount).catch((e) => console.error(e));
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "players"),
      { includeMetadataChanges: true },
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data({ serverTimestamps: "estimate" }),
        }));
        setPlayers(list);
        markLoaded("players", snap);
      }
    );
    return unsub;
  }, []);

  // Background actions (auto-fill) only run on confirmed-fresh data, so a
  // stale cached queue can never trigger a wrong auto-fill.
  const ready = fresh.settings && fresh.courts && fresh.players;
  const showLoading = !(loaded.courts && loaded.players);

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
        (otherCourt.staged || []).forEach((id) => id && elsewhere.add(id));
      });
      stagedByCourt.set(court.id, elsewhere);
    });
    return stagedByCourt;
  }, [visibleCourts]);

  useEffect(() => {
    if (!ready || autoFillInProgress.current || waitingPlayers.length < 4) return;
    // "Empty" means no one in the box is actually still waiting — leftover
    // ids of people who left or started elsewhere must not block a refill.
    const waitingIds = new Set(waitingPlayers.map((p) => p.id));
    const emptyCourts = visibleCourts.filter(
      (court) => !(court.staged || []).some((id) => id && waitingIds.has(id))
    );
    if (emptyCourts.length === 0) return;
    autoFillInProgress.current = true;
    // One atomic pass across every empty court at once — not a loop of
    // separate calls — so 2+ courts finishing games around the same time
    // can't step on each other's reads/writes and leave a box jumbled or
    // empty.
    autoFillAllStaging(emptyCourts.map((court) => court.id))
      .catch((error) => {
        console.error("Couldn't automatically fill Up Next:", error);
      })
      .finally(() => {
        autoFillInProgress.current = false;
      });
  }, [ready, visibleCourts, waitingPlayers]);

  // Manual start: an organizer taps "Start game" on an idle court once
  // enough people are waiting. The transaction still protects against
  // two people tapping at the same instant on different devices.
  async function handleStartGame(courtId, stagedIds) {
    if (stagedIds?.length === 4) {
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
      alert("Couldn't end the session — check your connection and try again.");
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
          <button className="gear-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      {(showLoading || !ready) && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(224,117,47,0.12)",
            fontSize: 13,
          }}
        >
          {showLoading
            ? "Loading the latest queue…"
            : "Showing saved data — reconnecting to get the latest…"}
        </div>
      )}

      <div className="layout">
        <div className="col">
          <RegisterForm />
          {visibleCourts.map((court) => {
            const nextPlayers = [0, 1, 2, 3]
              .map((i) => waitingPlayers.find((player) => player.id === (court.staged || [])[i]))
              .filter(Boolean);

            return (
              <div className="court-block" key={court.id}>
              <CourtCard
                court={court}
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
