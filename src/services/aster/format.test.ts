/**
 * Tests de presentación de resultados del catálogo.
 */
import { describe, expect, it } from "vitest";
import {
  formatFileHits,
  formatHistory,
  formatSearchSources,
  formatSystemReport,
  statusLabel,
} from "./format";
import type { AuditEntry, AuditStats, FileHit, SystemReport } from "../../types/aster";

function report(): SystemReport {
  return {
    osName: "Windows",
    osVersion: "11",
    build: "22631",
    architecture: "x64",
    hostname: "PC-ANA",
    user: "ana",
    cpu: "Ryzen 5",
    cpuThreads: 12,
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryAvailableBytes: 8 * 1024 ** 3,
    memoryUsedPercent: 50,
    uptimeSeconds: 3600,
    uptimeLabel: "1 h 0 min",
    disks: [],
    screens: 1,
    processes: [],
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("formatSystemReport", () => {
  it("no repite el procesador en el resumen", () => {
    const text = formatSystemReport(report(), "resumen");
    const hits = text.match(/Procesador/g) ?? [];
    expect(hits.length).toBe(1);
  });
});

describe("formatSearchSources", () => {
  it("genera enlaces markdown clicables", () => {
    const out = formatSearchSources([{ title: "Guía", uri: "https://example.com" }]);
    expect(out).toContain("[Guía](https://example.com)");
  });

  it("sanea corchetes del título", () => {
    const out = formatSearchSources([{ title: "A [B]", uri: "https://example.com" }]);
    expect(out).not.toContain("[B]");
  });
});

describe("formatFileHits", () => {  it("resume carpetas y archivos", () => {
    const hits: FileHit[] = [
      {
        path: "C:\\Docs\\a",
        name: "a",
        isDirectory: true,
        sizeBytes: 0,
        sizeLabel: "carpeta",
        modifiedAt: "",
        scope: "documents",
      },
      {
        path: "C:\\Docs\\b.pdf",
        name: "b.pdf",
        isDirectory: false,
        sizeBytes: 10,
        sizeLabel: "10 B",
        modifiedAt: "",
        scope: "documents",
      },
    ];
    const text = formatFileHits(hits, "a");
    expect(text).toContain("1 carpeta");
    expect(text).toContain("1 archivo");
  });

  it("sin resultados lo dice claro", () => {
    expect(formatFileHits([], "zzz")).toContain("No encontré nada");
  });
});

describe("formatHistory", () => {
  const stats = {
    total: 2,
    byAction: [],
    byStatus: [
      { status: "success", total: 1 },
      { status: "error", total: 1 },
    ],
    confirmedOperations: 0,
    guardedOperations: 0,
    auditFile: "audit.jsonl",
  } as AuditStats;

  it("vacío con y sin filtro", () => {
    expect(formatHistory([], stats, undefined)).toContain("Todavía no hay");
    expect(formatHistory([], stats, "move_files")).toContain("move_files");
  });

  it("marca estado y confirmación", () => {
    const entries = [
      {
        id: "1",
        timestamp: "",
        action: "move_files",
        label: "Mover archivos",
        status: "success",
        target: "a",
        summary: "ok",
        confirmed: true,
        origin: "ui",
        latencyMs: 5,
      },
    ] as AuditEntry[];
    const text = formatHistory(entries, stats, undefined);
    expect(text).toContain("✓");
    expect(text).toContain("confirmada");
    expect(text).toContain("2 acciones registradas");
  });
});

describe("statusLabel", () => {
  it("traduce los 5 estados", () => {
    expect(statusLabel("success")).toBe("correctas");
    expect(statusLabel("error")).toBe("con error");
    expect(statusLabel("denied")).toBe("denegadas");
    expect(statusLabel("cancelled")).toBe("canceladas");
    expect(statusLabel("pending")).toBe("pendientes");
  });
});
