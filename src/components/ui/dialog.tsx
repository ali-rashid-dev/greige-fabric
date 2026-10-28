"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div className="modal-backdrop">
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content className={cn("modal", wide && "wide")} aria-describedby={undefined}>
          <header className="modal-header">
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button type="button" className="close-button" aria-label="Close dialog">
                <X aria-hidden="true" size={18} />
              </button>
            </DialogPrimitive.Close>
          </header>
          <div className="modal-content">{children}</div>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}
