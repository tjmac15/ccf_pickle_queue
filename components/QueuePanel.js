"use client";

import { useEffect, useState } from "react";
import { withdrawPlayer } from "../lib/queueLogic";

function waitLabel(joinedAt, now) {
  if (!joinedAt) return "just joined";
  const seconds = Math.max(0, Math.floor((now - joinedAt.toMillis()) / 1000));
  if (seconds < 60) return "just joined";
  const mins = Math.floor(seconds / 60);
  return `${mins} min`;
}

function gamesLabel(n) {
  const count = n || 0;
  return `${count} game${count === 1 ? "" : "s"} played`;
}

function sortPlayers(list, sortBy) {
  switch (sortBy) {
    case "mostGames":
      return [...list].sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0));
    case "fewestGames":
      return [...list].sort((a, b) => (a.gamesPlayed || 0) - (b.gamesPlayed || 0));
    case "mostWins":
      return [...list].sort((a, b) => (b.wins || 0) - (a.wins || 0));
    case "fewestWins":
      return [...list].sort((a, b) => (a.wins || 0) - (b.wins || 0));
    default:
      return list;
  }
}

function SortSelect({ value, onChange, defaultLabel }) {
  return (
    <div className="sort-toggle">
      <span>Sort by:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="default">{defaultLabel}</option>
        <option value="mostGames">Most games played</option>
        <option value="fewestGames">Fewest games played</option>
        <option value="mostWins">Most wins</option>
        <option value="fewestWins">Fewest wins</option>
      </select>
    </div>
  );
}

export default function QueuePanel({ waitingPlayers, playingPlayers, onReorder, onReorderFull }) {
  const [now, setNow] = useState(Date.now());
  const [sortBy, setSortBy] = useState("default");
  const [playingSortBy, setPlayingSortBy] = useState("default");
  const [draggingId, setDraggingId] = useState(null);
  const [overId, setOverId] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const displayed = sortPlayers(waitingPlayers, sortBy);
  const displayedPlaying = sortPlayers(playingPlayers, playingSortBy);

  // Drag-and-drop reordering, implemented with Pointer Events (not the
  // older HTML5 drag API) so it works on touch — iPad included — as
  // well as mouse. Works alongside the ↑/↓ arrows regardless of which
  // sort view you're looking at — both always act on the real queue
  // position, not the temporary sorted display order.
  function handlePointerDown(e, id) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingId(id);
  }

  function handlePointerMove(e) {
    if (!draggingId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el && el.closest("[data-player-id]");
    if (row) {
      const id = row.getAttribute("data-player-id");
      if (id !== draggingId) setOverId(id);
    }
  }

  function handlePointerUp() {
    if (draggingId && overId && draggingId !== overId) {
      const ids = waitingPlayers.map((p) => p.id);
      const fromIdx = ids.indexOf(draggingId);
      const toIdx = ids.indexOf(overId);
      if (fromIdx !== -1 && toIdx !== -1) {
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, draggingId);
        onReorderFull(ids);
      }
    }
    setDraggingId(null);
    setOverId(null);
  }

  return (
    <div className="panel">
      {playingPlayers.length > 0 && (
        <div className="playing-now-section">
          <h2>
            Playing now <span className="count">{playingPlayers.length}</span>
          </h2>
          <SortSelect value={playingSortBy} onChange={setPlayingSortBy} defaultLabel="Court order" />
          {displayedPlaying.map((p) => (
            <div className="playing-row" key={p.id}>
              <span className="queue-status-tag playing">Playing</span>
              <span className="queue-name">{p.name}</span>
              <span className="queue-games">{gamesLabel(p.gamesPlayed)}</span>
              <span className="playing-court-tag">Court {p.courtId}</span>
            </div>
          ))}
        </div>
      )}

      <h2>
        Queue <span className="count">{waitingPlayers.length} waiting</span>
      </h2>

      {waitingPlayers.length > 0 && (
        <SortSelect value={sortBy} onChange={setSortBy} defaultLabel="Queue order" />
      )}

      {sortBy !== "default" && waitingPlayers.length > 0 && (
        <p className="sort-hint">
        
        </p>
      )}

      {waitingPlayers.length === 0 && (
        <div className="empty-note">No one's waiting — join above to get started.</div>
      )}

      {displayed.map((p) => {
        const queuePosition = waitingPlayers.indexOf(p);
        return (
          <div
            className={`queue-row ${draggingId === p.id ? "dragging" : ""} ${
              overId === p.id ? "drag-over" : ""
            }`}
            data-player-id={p.id}
            key={p.id}
          >
            <span
              className="drag-handle"
              onPointerDown={(e) => handlePointerDown(e, p.id)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              aria-label="Drag to reorder"
            >
              ⠿
            </span>
            <span className="queue-badge">No.{queuePosition + 1}</span>
            <span className="queue-status-tag waiting">Waiting</span>
            <span className="queue-name">{p.name}</span>
            <span className="queue-games">{gamesLabel(p.gamesPlayed)}</span>
            <span className="queue-wait">{waitLabel(p.joinedAt, now)}</span>
            <div className="reorder-btns">
              <button
                disabled={queuePosition === 0}
                onClick={() => onReorder(p.id, "up")}
                aria-label="Move up in queue"
              >
                ↑
              </button>
              <button
                disabled={queuePosition === waitingPlayers.length - 1}
                onClick={() => onReorder(p.id, "down")}
                aria-label="Move down in queue"
              >
                ↓
              </button>
            </div>
            <button className="withdraw-btn" onClick={() => withdrawPlayer(p.id)}>
              leave
            </button>
          </div>
        );
      })}
    </div>
  );
}