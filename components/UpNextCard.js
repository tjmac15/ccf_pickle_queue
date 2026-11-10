"use client";

import SkillBadge from "./SkillBadge";
import { slotCount } from "../lib/queueLogic";

export default function UpNextCard({ court, lane = "staged", waitingPlayers, stagedElsewhereIds, onAutoFill, onRedraw, onRemove, onAdd, onStart, onSwap }) {
  const level = lane === "staged3" ? 3 : lane === "staged2" ? 2 : 1;
  const second = level > 1;
  const n = slotCount(court);
  const half = n / 2;

  // Slot-preserving: slot i is whoever sits at court.staged[i] (or empty),
  // so removing/swapping one person never shifts anyone's team. Anyone no
  // longer waiting just shows as an open slot.
  const slots = Array.from({ length: n }, (_, i) =>
    waitingPlayers.find((p) => p.id === (court[lane] || [])[i]) || null
  );
  const staged = slots.filter(Boolean);

  const availablePlayers = waitingPlayers.filter(
    (p) => !staged.some((s) => s.id === p.id) && !stagedElsewhereIds.has(p.id)
  );

  const isCourtAvailable = court.status === "idle";
  const canStart = staged.length === n && isCourtAvailable;

  const sum = (list) => list.reduce((t, p) => t + (p ? p.skill || 3 : 0), 0);
  const skillText =
    staged.length === n ? `Skill ${sum(slots.slice(0, half))} vs ${sum(slots.slice(half))}` : null;

  function renderSlot(player, key) {
    if (player) {
      return (
        <div className="upnext-slot filled" key={key}>
          <span className="upnext-slot-name">
            <SkillBadge skill={player.skill} /> {player.name}
          </span>
          <button onClick={() => onRemove(court.id, player.id)} aria-label={`Remove ${player.name}`}>
            ×
          </button>
        </div>
      );
    }
    return (
      <div
        className="upnext-slot empty drop-target"
        key={key}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const playerId = e.dataTransfer.getData("application/x-pickle-player");
          if (playerId && availablePlayers.some((p) => p.id === playerId)) onAdd(court.id, playerId, lane);
        }}
      >
        <span className="upnext-slot-hint">Drag a queue player here, or</span>
        <select
          className="upnext-slot-select"
          defaultValue=""
          // Native drag-and-drop doesn't work on iPad/touch, so this
          // dropdown is the reliable way to fill a slot there.
          onChange={(e) => {
            const playerId = e.target.value;
            if (playerId) onAdd(court.id, playerId, lane);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Tap to pick a player…
          </option>
          {availablePlayers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (skill {p.skill || 3})
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className={`upnext-card ${second ? "upnext-second" : ""}`}>
      <div className="upnext-head">
        <h3>
          {`Up Next ${level} — Court ${court.number}`}
          <span className={`upnext-badge ${second ? "" : "priority"}`}>{level === 1 ? "priority" : level === 2 ? "after that" : "then"}</span>
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="upnext-autofill" onClick={() => onAutoFill(court.id)}>
            Auto-fill
          </button>
          <button className="upnext-autofill" onClick={() => onRedraw(court.id)} title="Clear both Up Next boxes and pick again from the line">
            Redraw
          </button>
          {second && (
            <button className="upnext-autofill" onClick={() => onSwap(court.id, lane)} title="Make this lineup the priority">
              ⇅ Swap up
            </button>
          )}
        </div>
      </div>
      <p className="upnext-hint">
        {(court.locked || []).includes(lane)
          ? "Edited by hand — press Redraw to follow the queue again."
          : second
          ? "Follows the queue: the next people after the box above."
          : "Follows the queue. Use × or the dropdown to change someone."}
        {skillText && <strong> {skillText}</strong>}
        {!second && court.king && <strong> · King of the court: {court.king.wins} win{court.king.wins === 1 ? "" : "s"} in a row</strong>}
      </p>
      <div className="upnext-teams">
        <div className="upnext-team">
          <div className="upnext-team-label team-a">Team 1</div>
          {slots.slice(0, half).map((p, i) => renderSlot(p, `slot-${i}`))}
        </div>
        <div className="upnext-team">
          <div className="upnext-team-label team-b">Team 2</div>
          {slots.slice(half).map((p, i) => renderSlot(p, `slot-${half + i}`))}
        </div>
      </div>
      {!second && (
      <button className="btn-primary upnext-start" disabled={!canStart} onClick={() => onStart(court.id, slots.map((p) => p && p.id))}>
        {isCourtAvailable ? "Start this match" : "Court currently in use"}
      </button>
      )}
    </div>
  );
}
