"use client";

import { useState } from "react";
import { getDesktopApi } from "@/lib/desktop-api";
import type { PrintDocumentInput } from "@/shared/contracts";

const paperFormats: PrintDocumentInput["paperFormat"][] = ["A4", "A5", "Letter", "Legal"];

export default function PrintActions({
  label,
  beforePrint,
}: {
  label: string;
  beforePrint?: () => (() => void) | undefined;
}) {
  const [paperFormat, setPaperFormat] = useState<PrintDocumentInput["paperFormat"]>("A4");
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");

  async function printDocument() {
    setPrinting(true);
    setError("");
    let cleanup: (() => void) | undefined = undefined;
    try {
      cleanup = beforePrint?.();
      if (!window.electronAPI) {
        throw new Error("The desktop print service is unavailable.");
      }
      const result = await getDesktopApi().documents.print({ paperFormat });
      if (!result.ok) throw new Error(result.error.message);
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : "Unable to print this document.");
    } finally {
      cleanup?.();
      setPrinting(false);
    }
  }

  return (
    <span className="document-print-actions no-print">
      <label>
        <span className="sr-only">Paper format</span>
        <select aria-label="Paper format" value={paperFormat} onChange={(event) => {
          const nextFormat = paperFormats.find((format) => format === event.target.value);
          if (nextFormat) setPaperFormat(nextFormat);
        }}>
          {paperFormats.map((format) => <option key={format} value={format}>{format}</option>)}
        </select>
      </label>
      <button className="primary-button" disabled={printing} onClick={() => void printDocument()}>
        {printing ? "Opening print preview…" : label}
      </button>
      {error && <span className="print-error" role="alert">{error}</span>}
    </span>
  );
}
