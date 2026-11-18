import React from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Zap } from 'lucide-react';
import type { CompatibilityAssessment } from '../types/engine';

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} ГБ`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

interface CompatibilityBadgeProps {
  assessment: CompatibilityAssessment | null | undefined;
  compact?: boolean;
}

export const CompatibilityBadge: React.FC<CompatibilityBadgeProps> = ({
  assessment,
  compact = false,
}) => {
  if (!assessment) {
    return (
      <span className="text-xs text-slate-400 font-mono">
        Размер неизвестен
      </span>
    );
  }

  let textColor = 'text-emerald-700';
  let Icon = Zap;

  if (assessment.verdict === 'gpu_full') {
    textColor = 'text-emerald-700';
    Icon = CheckCircle2;
  } else if (assessment.verdict === 'gpu_partial') {
    textColor = 'text-amber-700';
    Icon = Zap;
  } else if (assessment.verdict === 'cpu_only') {
    textColor = 'text-blue-700';
    Icon = Cpu;
  } else {
    textColor = 'text-rose-700';
    Icon = AlertTriangle;
  }

  return (
    <div className="space-y-0.5">
      <div className={`inline-flex items-center gap-1.5 text-xs font-semibold ${textColor}`}>
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span>{assessment.label}</span>
      </div>
      {!compact && (
        <div className="text-[11px] text-slate-500 leading-snug">
          {assessment.summary}
        </div>
      )}
    </div>
  );
};
