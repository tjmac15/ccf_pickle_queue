"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../../lib/firebase";
import SkillBadge from "../../components/SkillBadge";

const slotCount = (c) => (c.format === "singles" ? 2 : 4);

function clock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Read-only live copy of the session run on the organizer's device. It only
// ever READS one document, shows the last copy it has instantly (even with
// poor signal), and has no buttons that change anything.
export default function LiveView() {
  const [live, setLive] = useState(null);
  const [fromCache, setFromCache] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "live", "state"), { includeMetadataChanges: true }, (snap) => {
      if (snap.exists()) setLive(snap.data());
      setFromCache(snap.metadata.fromCache);
      setLoaded(true);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const view = useMemo(() => {
    if (!live) return null;
    const players = live.players || [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const waiting = players.filter((p) => p.status === "waiting").sort((a, b) => a.joinedAt - b.joinedAt);
    const courts = (live.courts || []).filter((c) => c.number <= (live.settings?.courtCount || 1));
    const ranked = players
      .filter((p) => p.gamesPlayed > 0)
      .sort((a, b) => b.wins - a.wins || b.points - a.points)
      .slice(0, 15);
    return { players, byId, waiting, courts, ranked };
  }, [live]);

  if (!loaded) {
    return (
      <div className="shell">
        <div className="empty-note">Loading the live queue…</div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="shell">
        <h1>CCF Open Play — Live</h1>
        <div className="empty-note">The organizer hasn't started sharing yet. This page updates by itself.</div>
      </div>
    );
  }

  const ageSec = Math.max(0, Math.round((now - (live.updatedAt || 0)) / 1000));
  const stale = ageSec > 120;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>CCF Open Play — Live</h1>
            <div className="sub">Read-only · {view.waiting.length} waiting</div>
          </div>
        </div>
      </div>

      <div className={`view-banner ${stale ? "stale" : ""}`}>
        {stale
          ? `Last update ${Math.round(ageSec / 60)} min ago — the organizer may be offline. Showing the last known queue.`
          : `Live · updated ${ageSec}s ago`}
        {fromCache && " · showing saved copy"}
      </div>

      <div className="layout">
        <div className="col">
          {view.courts.map((c) => {
            const playing = c.status === "playing";
            const n = slotCount(c);
            const half = n / 2;
            const ids = playing ? c.playerIds : [];
            const remaining = playing ? (c.gameMinutes || 10) * 60 - (now - (c.startTime || now)) / 1000 : 0;
            const team = (list) =>
              list.map((id, i) => {
                const p = view.byId.get(id);
                return (
                  <div className="court-player-row" key={id || i}>
                    {p && <SkillBadge skill={p.skill} />}
                    <span className="court-player-name">{p ? p.name : (c.playerNames || [])[ids.indexOf(id)]}</span>
                  </div>
                );
              });
            const next = Array.from({ length: n }, (_, i) => view.byId.get((c.staged || [])[i])).filter((p) => p && p.status === "waiting");
            return (
              <div className="court-block" key={c.id}>
                <div className="court-card">
                  <div className="court-head">
                    <div>
                      <div className="court-label">Court</div>
                      <div className="court-number">{c.number}</div>
                    </div>
                    <span className={`court-status-pill ${playing ? "playing" : ""}`}>
                      {playing ? (remaining <= 0 ? "Time's up" : "In play") : "Open"}
                    </span>
                  </div>
                  {playing ? (
                    <>
                      <div className="court-teams">
                        <div className="team team-a">{team(ids.slice(0, half))}</div>
                        <span className="vs">vs</span>
                        <div className="team team-b">{team(ids.slice(half))}</div>
                      </div>
                      <div className="view-score">
                        {c.liveScoreA || 0} <span>–</span> {c.liveScoreB || 0}
                      </div>
                      <div className="timer">{remaining <= 0 ? "0:00" : clock(remaining)}</div>
                    </>
                  ) : (
                    <div className="court-idle-msg">Waiting for the next match.</div>
                  )}
                </div>
                <div className="upnext-card">
                  <div className="upnext-head">
                    <h3>Up Next — Court {c.number}</h3>
                  </div>
                  {next.length === 0 ? (
                    <div className="empty-note">Not set yet.</div>
                  ) : (
                    <div className="court-next-players view-next">
                      {next.map((p) => (
                        <span key={p.id}>
                          <SkillBadge skill={p.skill} /> {p.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="col">
          <div className="panel">
            <h2>
              Queue <span className="count">{view.waiting.length} waiting</span>
            </h2>
            {view.waiting.length === 0 && <div className="empty-note">No one's waiting.</div>}
            {view.waiting.map((p, i) => (
              <div className="view-row" key={p.id}>
                <span className="queue-badge">No.{i + 1}</span>
                <span className="queue-name">
                  <SkillBadge skill={p.skill} /> {p.name}
                </span>
                <span className="queue-games">{p.gamesPlayed} games</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Leaderboard</h2>
            {view.ranked.length === 0 && <div className="empty-note">Scores appear once games finish.</div>}
            {view.ranked.map((p, i) => (
              <div className="lb-row" key={p.id}>
                <span className="lb-rank">{i + 1}</span>
                <span className="lb-name">{p.name}</span>
                <span className="lb-games">{p.gamesPlayed} games</span>
                <span className="lb-record">
                  {p.wins}-{p.losses}
                </span>
                <span className="lb-points">{p.points} pts</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
