"use client";

import { updateSettings } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

export default function SettingsPanel({ settings, onClose }) {
  useEscapeKey(onClose, !!settings);

  if (!settings) return null;

  function update(patch) {
    updateSettings(patch);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Open play settings</h3>
        <p className="hint">
          Saved on this device. Game length here sets every
          court at once — you can still nudge an individual court up or down
          with the +/− next to its timer.
        </p>

        <div className="settings-field">
          <label>Courts</label>
          <div className="stepper">
            <button
              onClick={() => update({ courtCount: Math.max(1, settings.courtCount - 1) })}
            >
              −
            </button>
            <span>{settings.courtCount}</span>
            <button onClick={() => update({ courtCount: settings.courtCount + 1 })}>
              +
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label>Game length (minutes)</label>
          <div className="stepper">
            <button
              onClick={() => update({ gameMinutes: Math.max(1, settings.gameMinutes - 1) })}
            >
              −
            </button>
            <span>{settings.gameMinutes}</span>
            <button onClick={() => update({ gameMinutes: settings.gameMinutes + 1 })}>
              +
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label>Points to win</label>
          <div className="stepper">
            <button onClick={() => update({ pointsToWin: Math.max(1, (settings.pointsToWin || 11) - 1) })}>−</button>
            <span>{settings.pointsToWin || 11}</span>
            <button onClick={() => update({ pointsToWin: (settings.pointsToWin || 11) + 1 })}>+</button>
          </div>
        </div>

        <div className="settings-field">
          <label>Win by 2</label>
          <button className={`toggle ${settings.winByTwo ? "on" : ""}`} onClick={() => update({ winByTwo: !settings.winByTwo })}>
            <span className="knob" />
          </button>
        </div>

        <div className="settings-field">
          <label>Track serving &amp; side-outs</label>
          <button className={`toggle ${settings.trackServe ? "on" : ""}`} onClick={() => update({ trackServe: !settings.trackServe })}>
            <span className="knob" />
          </button>
        </div>

        <div className="settings-field">
          <label>King of the Court: max wins in a row</label>
          <div className="stepper">
            <button onClick={() => update({ kingMaxWins: Math.max(1, (settings.kingMaxWins || 2) - 1) })}>−</button>
            <span>{settings.kingMaxWins || 2}</span>
            <button onClick={() => update({ kingMaxWins: (settings.kingMaxWins || 2) + 1 })}>+</button>
          </div>
        </div>

        <div className="settings-field">
          <label>Auto-requeue after a game</label>
          <button
            className={`toggle ${settings.autoRequeue ? "on" : ""}`}
            onClick={() => update({ autoRequeue: !settings.autoRequeue })}
          >
            <span className="knob" />
          </button>
        </div>
      </div>
    </div>
  );
}