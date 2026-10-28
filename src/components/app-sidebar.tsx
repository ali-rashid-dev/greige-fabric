"use client";

import {
  ArchiveRestore,
  BarChart3,
  Boxes,
  Handshake,
  Layers,
  Receipt,
  RotateCcw,
  Shirt,
  ShoppingCart,
  Users,
  Wallet,
} from "lucide-react";
import { businessConfig } from "@/config/business";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type Section =
  | "pos"
  | "fabrics"
  | "stock"
  | "suppliers"
  | "customers"
  | "invoices"
  | "expenses"
  | "reports"
  | "returns"
  | "backups"
  | "partners";

const navigation: Array<{
  id: Section;
  label: string;
  icon: typeof ShoppingCart;
}> = [
  { id: "pos", label: "New sale", icon: ShoppingCart },
  { id: "fabrics", label: "Fabric catalog", icon: Shirt },
  { id: "stock", label: "Inventory", icon: Boxes },
  { id: "suppliers", label: "Suppliers", icon: Handshake },
  { id: "customers", label: "Customers", icon: Users },
  { id: "invoices", label: "Sales history", icon: Receipt },
  { id: "expenses", label: "Expenses & cashbook", icon: Wallet },
  { id: "partners", label: "Partnership & Investors", icon: Handshake },
  { id: "reports", label: "Reports & analytics", icon: BarChart3 },
  { id: "returns", label: "Returns & audit", icon: RotateCcw },
  { id: "backups", label: "Backup & recovery", icon: ArchiveRestore },
];

export function AppSidebar({
  section,
  lowStockCount,
  onSectionChange,
}: {
  section: Section;
  lowStockCount: number;
  onSectionChange: (section: Section) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><Layers size={19} /></div>
        <div>
          <p className="brand-name">{businessConfig.name}</p>
          <p className="brand-caption">FABRIC POS</p>
        </div>
      </div>
      <nav className="main-nav" aria-label="Main navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            className={`nav-item${section === id ? " active" : ""}`}
            aria-current={section === id ? "page" : undefined}
            title={label}
            onClick={() => onSectionChange(id)}
          >
            <Icon className="nav-icon" aria-hidden="true" size={17} />
            <span className="nav-label">{label}</span>
            {id === "stock" && lowStockCount > 0 && (
              <Badge variant="warning" className="nav-count">{lowStockCount}</Badge>
            )}
          </Button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <span className="connection-dot" />
        <span>Saved on this device</span>
        <span className="currency-small">{businessConfig.currency}</span>
      </div>
    </aside>
  );
}
