import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SummaryCard({
  label,
  value,
  icon,
  warning = false,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  warning?: boolean;
}) {
  return (
    <Card asChild>
      <article className="summary-card">
        <span className={cn("summary-icon", warning && "warning")}>{icon}</span>
        <div><p>{label}</p><strong>{value}</strong></div>
      </article>
    </Card>
  );
}

export function FormField({
  label,
  required = false,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="form-field">
      <span>{label}{required && <b> *</b>}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function StatusBadge({ active, low = false }: { active: boolean; low?: boolean }) {
  const variant = !active ? "secondary" : low ? "warning" : "success";
  return (
    <Badge variant={variant} className={cn("status-badge", !active && "inactive", low && "low")}>
      <span aria-hidden="true" />
      {!active ? "Inactive" : low ? "Low stock" : "Active"}
    </Badge>
  );
}

export function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">▤</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}
