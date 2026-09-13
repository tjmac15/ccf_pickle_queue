"use client";

export default function SessionSummaryModal({ summary, onClose }) {
  if (!summary) return null;

  const { standings, totalGames } = summary;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Session ended</h3>
        <p className="hint">
          {totalGames} game{totalGames === 1 ? "" : "s"} played · queue and stats are reset for
          next time. Here's how today went:
        </p>

        {standings.length === 0 && (
          <div className="empty-note">No games were finished this session.</div>
        )}

        {standings.map((p, i) => (
          <div className="lb-row" key={p.id}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">{p.name}</span>
            <span className="lb-record">
              {p.wins}-{p.losses}
            </span>
            <span className="lb-points">{p.points} pts</span>
          </div>
        ))}

        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose} style={{ flex: 1 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}