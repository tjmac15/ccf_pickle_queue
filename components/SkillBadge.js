"use client";

import { SKILLS } from "../lib/queueLogic";

const COLORS = ["#e0a82e", "#3f9a54", "#3b78c9", "#7a4fc0", "#cc3b3b", "#222a35"];

// Small colored circle showing a player's skill level (1-6).
export default function SkillBadge({ skill }) {
  const level = Math.min(6, Math.max(1, Number(skill) || 3));
  return (
    <span
      className="skill-badge"
      style={{ background: COLORS[level - 1] }}
      title={`Skill ${level} — ${SKILLS[level - 1]}`}
    >
      {level}
    </span>
  );
}
