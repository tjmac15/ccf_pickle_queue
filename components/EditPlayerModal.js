"use client";

import { useEffect, useState } from "react";
import { updatePlayer, withdrawPlayer, SKILLS } from "../lib/queueLogic";
import { useEscapeKey } from "../lib/useEscapeKey";

// Edit a player's name and skill level (or take them out of the line).
export default function EditPlayerModal({ player, onClose }) {
  const [name, setName] = useState("");
  const [skill, setSkill] = useState(3);
  useEscapeKey(onClose, !!player);

  useEffect(() => {
    if (player) {
      setName(player.name || "");
      setSkill(player.skill || 3);
    }
  }, [player]);

  if (!player) return null;

  function save() {
    updatePlayer(player.id, { name, skill });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>Edit player</h3>
        <div className="settings-field" style={{ display: "block" }}>
          <label>Name</label>
          <input className="edit-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="settings-field" style={{ display: "block" }}>
          <label>Skill level</label>
          <select className="edit-input" value={skill} onChange={(e) => setSkill(Number(e.target.value))}>
            {SKILLS.map((label, i) => (
              <option key={label} value={i + 1}>
                {i + 1} · {label}
              </option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          {player.status === "waiting" && (
            <button
              className="btn-secondary"
              onClick={() => {
                withdrawPlayer(player.id);
                onClose();
              }}
            >
              Remove from line
            </button>
          )}
          <button className="btn-primary" onClick={save} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
