"use client";

import { useEffect, useState } from "react";
import { withdrawPlayer } from "../lib/queueLogic";

function waitLabel(joinedAt, now) {
  if (!joinedAt) return "just joined";
  const seconds = Math.max(0, Math.floor((now - joinedAt.toMillis()) / 1000));
  if (seconds < 60) return "just joined";
  const mins = Math.floor(seconds / 60);
  return `waiting ${mins} min`;
}

export default function QueuePanel({ waitingPlayers }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="panel">
      <h2>
        Queue <span className="count">{waitingPlayers.length} waiting</span>
      </h2>
      {waitingPlayers.length === 0 && (
        <div className="empty-note">No one's waiting — join above to get started.</div>
      )}
      {waitingPlayers.map((p, i) => (
        <div className="queue-row" key={p.id}>
          <span className="queue-badge">No.{i + 1}</span>
          <span className="queue-name">{p.name}</span>
          <span className="queue-wait">{waitLabel(p.joinedAt, now)}</span>
          <button className="withdraw-btn" onClick={() => withdrawPlayer(p.id)}>
            leave
          </button>
        </div>
      ))}
    </div>
  );
}
