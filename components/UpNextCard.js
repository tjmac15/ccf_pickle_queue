"use client";

import { useState } from "react";

export default function UpNextCard({ court, waitingPlayers, stagedElsewhereIds, onAutoFill, onRemove, onAdd, onStart }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Only count ids that still resolve to an actual waiting player — if
  // someone staged here left the queue, their slot just opens back up
  // instead of silently blocking the match from starting.
  const staged = (court.staged || [])
    .map((id) => waitingPlayers.find((p) => p.id === id))
    .filter(Boolean);

  const availablePlayers = waitingPlayers.filter(
    (p) => !staged.some((s) => s.id === p.id) && !stagedElsewhereIds.has(p.id)
  );

  const slots = [0, 1, 2, 3].map((i) => staged[i] || null);
  const isCourtAvailable = court.status === "idle";
  const canStart = staged.length === 4 && isCourtAvailable;

  function renderSlot(player, key) {
    if (player) {
      return (
        <div className="upnext-slot filled" key={key}>
          <span>{player.name}</span>
          <button onClick={() => onRemove(court.id, player.id)} aria-label={`Remove ${player.name}`}>
            ×
          </button>
        </div>
      );
    }
    return (
      <button className="upnext-slot empty upnext-add-slot" key={key} onClick={() => setPickerOpen(true)}>
        + Add player
      </button>
    );
  }

  return (
    <div className="upnext-card">
      <div className="upnext-head">
        <h3>Up Next — Court {court.number}</h3>
        <button className="upnext-autofill" onClick={() => onAutoFill(court.id)}>
          Auto-fill
        </button>
      </div>
      <p className="upnext-hint">Tap an open slot, then tap a waiting player. Use × to remove them.</p>
      <div className="upnext-teams">
        <div className="upnext-team">
          <div className="upnext-team-label team-a">Team 1</div>
          {renderSlot(slots[0], "slot-0")}
          {renderSlot(slots[1], "slot-1")}
        </div>
        <div className="upnext-team">
          <div className="upnext-team-label team-b">Team 2</div>
          {renderSlot(slots[2], "slot-2")}
          {renderSlot(slots[3], "slot-3")}
        </div>
      </div>
      {pickerOpen && (
        <div className="upnext-picker" role="dialog" aria-label="Choose a waiting player">
          <div className="upnext-picker-head">
            <strong>Add a player</strong>
            <button onClick={() => setPickerOpen(false)} aria-label="Close player picker">×</button>
          </div>
          {availablePlayers.length > 0 ? (
            <div className="upnext-picker-list">
              {availablePlayers.map((player) => (
                <button
                  key={player.id}
                  onClick={() => {
                    onAdd(court.id, player.id);
                    setPickerOpen(false);
                  }}
                >
                  {player.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="upnext-picker-empty">No unassigned players are waiting.</p>
          )}
        </div>
      )}
      <button
        className="btn-primary upnext-start"
        disabled={!canStart}
        onClick={() => onStart(court.id)}
      >
        {isCourtAvailable ? "Start this match" : "Court currently in use"}
      </button>
    </div>
  );
}
