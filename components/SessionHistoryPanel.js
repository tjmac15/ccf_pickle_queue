"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";

function formatDate(ts) {
  if (!ts) return "…";
  return ts.toDate().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SessionHistoryPanel() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    const q = query(collection(db, "sessions"), orderBy("endedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({
        id: d.id,
        ...d.data({ serverTimestamps: "estimate" }),
      }));
      setSessions(list);
      setSelectedId((prev) => prev || (list[0] && list[0].id) || null);
    });
    return unsub;
  }, []);

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