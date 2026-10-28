import { businessConfig } from "@/config/business";

export function formatMoney(minor: number): string {
  const amount = new Intl.NumberFormat("en-PK", {
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return `${businessConfig.currency} ${amount}`;
}

export function formatMeters(millimeters: number): string {
  return `${(millimeters / 1000).toLocaleString("en-PK", {
    maximumFractionDigits: 3,
  })} m`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
