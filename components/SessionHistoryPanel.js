"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";

function formatDate(ts) {
  if (!ts) return "…";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SessionHistoryPanel({ pending = [] }) {
  const [uploaded, setUploaded] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    const q = query(collection(db, "sessions"), orderBy("endedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({
        id: d.id,
        ...d.data({ serverTimestamps: "estimate" }),
      }));
      setUploaded(list);
    });
    return unsub;
  }, []);

  // Sessions still on this device (not uploaded yet) show up right away.
  const sessions = [...pending, ...uploaded.filter((u) => !pending.some((p) => p.id === u.id))].sort(
    (a, b) =>
      (b.endedAt?.toMillis ? b.endedAt.toMillis() : b.endedAt || 0) -
      (a.endedAt?.toMillis ? a.endedAt.toMillis() : a.endedAt || 0)
  );
  useEffect(() => {
    setSelectedId((prev) => prev || (sessions[0] && sessions[0].id) || null);
  }, [sessions.length]);

  const selected = sessions.find((s) => s.id === selectedId);

  return (
    <div className="panel">
      <h2>Session history</h2>

      {sessions.length === 0 && (
        <div className="empty-note">
          No sessions saved yet — one gets recorded automatically every time you tap "End
          session."
        </div>
      )}

      {sessions.length > 0 && (
        <select
          className="session-select"
          value={selectedId || ""}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {formatDate(s.endedAt)} — {s.totalPlayers} players, {s.totalGames} games
            </option>
          ))}
        </select>
      )}

      {selected && selected.standings.length === 0 && (
        <div className="empty-note">No games were finished that session.</div>
      )}

      {selected &&
        selected.standings.map((p, i) => (
          <div className="lb-row" key={p.id}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">{p.name}</span>
            <span className="lb-games">{p.gamesPlayed || 0} games</span>
            <span className="lb-record">
              {p.wins}-{p.losses}
            </span>
            <span className="lb-points">{p.points} pts</span>
          </div>
        ))}
    </div>
  );
}