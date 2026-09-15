"use client";

import { doc, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { ensureCourtsExist, setAllCourtsMinutes } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

export default function SettingsPanel({ settings, onClose }) {
  useEscapeKey(onClose, !!settings);

  if (!settings) return null;

  async function update(patch) {
    await setDoc(doc(db, "config", "settings"), patch, { merge: true });
    if (patch.courtCount) {
      await ensureCourtsExist(patch.courtCount, settings.gameMinutes);
    }
    if (patch.gameMinutes) {
      await setAllCourtsMinutes(settings.courtCount, patch.gameMinutes);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Open play settings</h3>
        <p className="hint">
          Changes sync to every device immediately. Game length here sets every
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