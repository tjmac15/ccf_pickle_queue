"use client";

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// Finished games from the current session, plus a CSV export (opens in Excel).
export default function ResultsPanel({ matches, players }) {
  const list = [...matches].reverse();

  function exportCsv() {
    const rows = [["Court", "Team A", "Team B", "Score A", "Score B", "Winner", "Finished"]];
    matches.forEach((m) => {
      const half = Math.ceil(m.playerIds.length / 2);
      rows.push([
        m.courtId,
        m.playerNames.slice(0, half).join(" & "),
        m.playerNames.slice(half).join(" & "),
        m.scoreA ?? "",
        m.scoreB ?? "",
        m.winner ? `Team ${m.winner}` : "",
        new Date(m.finishedAt).toLocaleString(),
      ]);
    });
    rows.push([]);
    rows.push(["Player", "Skill", "Games", "Wins", "Losses", "Points"]);
    players
      .filter((p) => (p.gamesPlayed || 0) > 0)
      .sort((a, b) => (b.wins || 0) - (a.wins || 0))
      .forEach((p) => rows.push([p.name, p.skill || 3, p.gamesPlayed || 0, p.wins || 0, p.losses || 0, p.points || 0]));
    download(`open-play-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"));
  }

  return (
    <div className="panel">
      <h2>
        Results <span className="count">{matches.length} games</span>
      </h2>
      {matches.length > 0 && (
        <button className="btn-secondary export-btn" onClick={exportCsv}>
          Export to Excel (CSV)
        </button>
      )}
      {matches.length === 0 && <div className="empty-note">Finished games appear here.</div>}
      {list.map((m) => {
        const half = Math.ceil(m.playerIds.length / 2);
        const a = m.playerNames.slice(0, half).join(" & ");
        const b = m.playerNames.slice(half).join(" & ");
        return (
          <div className="result-row" key={m.id}>
            <div className="result-meta">
              Court {m.courtId} · {new Date(m.finishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </div>
            <div className={`result-team ${m.winner === "A" ? "won" : ""}`}>
              <span>{a}</span>
              <b>{m.scoreA ?? (m.winner === "A" ? "W" : "")}</b>
            </div>
            <div className={`result-team ${m.winner === "B" ? "won" : ""}`}>
              <span>{b}</span>
              <b>{m.scoreB ?? (m.winner === "B" ? "W" : "")}</b>
            </div>
          </div>
        );
      })}
    </div>
  );
}
