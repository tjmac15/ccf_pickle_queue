"use client";

export default function UpNextCard({ court, waitingPlayers, stagedElsewhereIds, onAutoFill, onRemove, onAdd, onStart }) {
  // Only count ids that still resolve to an actual waiting player — if
  // someone staged here left the queue, their slot just opens back up
  // instead of silently blocking the match from starting.
  // Slot-preserving: slot i is whoever sits at court.staged[i] (or empty),
  // so removing/swapping one person never shifts anyone's team.
  const slots = [0, 1, 2, 3].map(
    (i) => waitingPlayers.find((p) => p.id === (court.staged || [])[i]) || null
  );
  const staged = slots.filter(Boolean);

  const availablePlayers = waitingPlayers.filter(
    (p) => !staged.some((s) => s.id === p.id) && !stagedElsewhereIds.has(p.id)
  );

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
      <div
        className="upnext-slot empty drop-target"
        key={key}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const playerId = e.dataTransfer.getData("application/x-pickle-player");
          if (playerId && availablePlayers.some((p) => p.id === playerId)) onAdd(court.id, playerId);
        }}
      >
        <span className="upnext-slot-hint">Drag a queue player here, or</span>
        <select
          className="upnext-slot-select"
          defaultValue=""
          // Native drag-and-drop doesn't work on iPad/touch at all, so
          // this dropdown is the only reliable way to fill a slot there
          // — keep it alongside the drag target rather than instead of it.
          onChange={(e) => {
            const playerId = e.target.value;
            if (playerId) onAdd(court.id, playerId);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Tap to pick a player…
          </option>
          {availablePlayers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
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
      <p className="upnext-hint">Drag a queue player into a slot, or use the dropdown on iPad/touch. Use × to remove them.</p>
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
      <button
        className="btn-primary upnext-start"
        disabled={!canStart}
        onClick={() => onStart(court.id, staged.map((p) => p.id))}
      >
        {isCourtAvailable ? "Start this match" : "Court currently in use"}
      </button>
    </div>
  );
}
