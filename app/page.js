"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import {
  ensureSettingsExist,
  ensureCourtsExist,
  fillCourtIfPossible,
  adjustCourtMinutes,
  DEFAULT_SETTINGS,
} from "../lib/queueLogic";

import RegisterForm from "../components/RegisterForm";
import CourtCard from "../components/CourtCard";
import QueuePanel from "../components/QueuePanel";
import Leaderboard from "../components/Leaderboard";
import ScoreModal from "../components/ScoreModal";
import SettingsPanel from "../components/SettingsPanel";

export default function Home() {
  const [settings, setSettings] = useState(null);
  const [courts, setCourts] = useState([]);
  const [players, setPlayers] = useState([]);
  const [pendingScore, setPendingScore] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
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

  const visibleCourts = useMemo(() => {
    if (!settings) return courts;
    return courts.filter((c) => c.number <= settings.courtCount);
  }, [courts, settings]);

  // Whenever the queue or courts change, try to seat the next group of
  // four on any open court. Safe to call repeatedly from every device.
  useEffect(() => {
    if (!ready) return;
    visibleCourts
      .filter((c) => c.status === "idle")
      .forEach((c) => fillCourtIfPossible(c.id));
  }, [ready, visibleCourts, waitingPlayers.length]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>CCF Open Play</h1>
            <div className="sub">Pickleball queue</div>
          </div>
        </div>
        <button className="gear-btn" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </div>

      <div className="layout">
        <div className="col">
          <RegisterForm />
          {visibleCourts.map((court) => (
            <CourtCard
              key={court.id}
              court={court}
              onEndGame={setPendingScore}
              onAdjustMinutes={adjustCourtMinutes}
            />
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
            </div>
          </div>
          {tab === "queue" ? (
            <QueuePanel waitingPlayers={waitingPlayers} />
          ) : (
            <Leaderboard players={players} />
          )}
        </div>
      </div>

      <ScoreModal
        pending={pendingScore}
        autoRequeue={settings?.autoRequeue ?? true}
        onClose={() => setPendingScore(null)}
      />
      {showSettings && (
        <SettingsPanel settings={settings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
