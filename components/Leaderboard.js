"use client";

export default function Leaderboard({ players }) {
  const ranked = [...players]
    .filter((p) => (p.gamesPlayed || 0) > 0)
    .sort((a, b) => {
      if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
      return (b.points || 0) - (a.points || 0);
    })
    .slice(0, 20);

  return (
    <div className="panel">
      <h2>Leaderboard</h2>
      {ranked.length === 0 && (
        <div className="empty-note">Scores will show up here once games are finished.</div>
      )}
      {ranked.map((p, i) => (
        <div className="lb-row" key={p.id}>
          <span className="lb-rank">{i + 1}</span>
          <span className="lb-name">{p.name}</span>
          <span className="lb-games">{p.gamesPlayed || 0} games</span>
          <span className="lb-record">
            {p.wins || 0}-{p.losses || 0}
          </span>
          <span className="lb-points">{p.points || 0} pts</span>
        </div>
      ))}
    </div>
  );
}
