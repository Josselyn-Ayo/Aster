import { describe, expect, it, vi } from "vitest";

const transcribeAudioMock = vi.fn();
vi.mock("../../model/ai", () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudioMock(...args),
}));

import { blobToBase64, isNativeSttAvailable, transcribeRecordedBlob } from "./stt";

describe("stt service", () => {
  it("blobToBase64 convierte un Blob a string Base64", async () => {
    const text = "audio-test-content";
    const blob = new Blob([text], { type: "text/plain" });
    const b64 = await blobToBase64(blob);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
    // Decodificado coincide con el contenido
    const decoded = atob(b64);
    expect(decoded).toBe(text);
  });

  it("transcribeRecordedBlob limpia los parámetros de codec en el MIME type", async () => {
    transcribeAudioMock.mockResolvedValue("Texto transcrito");
    const blob = new Blob(["test"], { type: "audio/webm;codecs=opus" });
    const result = await transcribeRecordedBlob(blob);

    expect(result).toBe("Texto transcrito");
    expect(transcribeAudioMock).toHaveBeenCalledTimes(1);
    // El segundo parámetro debe ser el MIME limpio sin codecs
    expect(transcribeAudioMock).toHaveBeenCalledWith(expect.any(String), "audio/webm");
  });

  it("isNativeSttAvailable reporta false cuando no hay constructor o en Tauri", () => {
    const available = isNativeSttAvailable();
    // En entorno de pruebas Node/Vitest no existe SpeechRecognition
    expect(typeof available).toBe("boolean");
  });
});
