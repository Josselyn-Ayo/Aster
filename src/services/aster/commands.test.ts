/**
 * Tests del contrato IPC de las 8 acciones (+ política y lista blanca).
 *
 * Con `invoke` mockeado se verifica que cada función llame al comando Rust
 * correcto con los argumentos exactos (nombres camelCase) que el backend
 * espera. Si alguien renombra un comando o un argumento, estos tests fallan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  auditList,
  cancelFileOperation,
  confirmFileOperation,
  findFiles,
  openAuthorizedApp,
  prepareFileOperation,
  systemReport,
} from "./commands";
import { auditStats } from "./commands";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe("contrato IPC de las 8 acciones", () => {
  it("1. open_authorized_app -> open_authorized_app { appName }", async () => {
    await openAuthorizedApp("Calculadora");
    expect(invokeMock).toHaveBeenCalledWith("open_authorized_app", {
      appName: "Calculadora",
    });
  });

  it("2. system_report sin topic envía detail null", async () => {
    await systemReport();
    expect(invokeMock).toHaveBeenCalledWith("system_report", { detail: null });
  });

  it("2b. system_report con topic", async () => {
    await systemReport("bateria");
    expect(invokeMock).toHaveBeenCalledWith("system_report", { detail: "bateria" });
  });

  it("3. find_files mapea scope/root/limit/foldersOnly", async () => {
    await findFiles({ query: ".pdf", scope: "documents", limit: 10 });
    expect(invokeMock).toHaveBeenCalledWith("find_files", {
      request: {
        query: ".pdf",
        scope: "documents",
        root: null,
        limit: 10,
        foldersOnly: false,
      },
    });
  });

  it("4. prepare_file_operation (create/move) con origin", async () => {
    await prepareFileOperation({ kind: "createFolder", path: "C:\\Docs\\X" }, "voice");
    expect(invokeMock).toHaveBeenCalledWith("prepare_file_operation", {
      request: { kind: "createFolder", path: "C:\\Docs\\X" },
      origin: "voice",
    });
  });

  it("4b. prepare_file_operation (createFile) serializa kind createFile", async () => {
    await prepareFileOperation({ kind: "createFile", path: "C:\\Docs\\notas.txt" }, "text");
    expect(invokeMock).toHaveBeenCalledWith("prepare_file_operation", {
      request: { kind: "createFile", path: "C:\\Docs\\notas.txt" },
      origin: "text",
    });
  });

  it("5. confirm_file_operation con id + veredicto", async () => {
    await confirmFileOperation("op-1", true, "ui");
    expect(invokeMock).toHaveBeenCalledWith("confirm_file_operation", {
      operationId: "op-1",
      approved: true,
      origin: "ui",
    });
  });

  it("6. cancel_file_operation descarta por id", async () => {
    await cancelFileOperation("op-1");
    expect(invokeMock).toHaveBeenCalledWith("cancel_file_operation", {
      operationId: "op-1",
    });
  });

  it("7. audit_list con filtros y valores por defecto", async () => {
    await auditList({ action: "move_files", limit: 25 });
    expect(invokeMock).toHaveBeenCalledWith("audit_list", {
      query: { limit: 25, offset: 0, action: "move_files", status: null, origin: null },
    });
  });

  it("7b. audit_stats no lleva argumentos", async () => {
    await auditStats();
    expect(invokeMock).toHaveBeenCalledWith("audit_stats");
  });
});
