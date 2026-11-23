import React from "react";

const tones: Record<string, string> = {
  "진행 중": "active",
  "실행 중": "active",
  양호: "good",
  완료: "good",
  취약: "bad",
  중단: "bad",
  실패: "bad",
  "판단 보류": "warn",
};

export function StatusChip({ label }: { label: string }) {
  const tone = tones[label] ?? "muted";
  return (
    <span className="status-chip" data-tone={tone}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
