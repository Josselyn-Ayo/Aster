/**
 * DataPolicy: política de voz (STT/TTS) y de almacenamiento del historial.
 *
 * Hace explícito lo que el proyecto exige: el almacenamiento se limita a lo
 * imprescindible para el historial y las grabaciones de voz no se almacenan de
 * forma permanente (de hecho, no se almacenan en absoluto: el audio se descarta
 * en cuanto el motor devuelve el texto).
 */
import { useEffect, useState } from "react";
import type { UserProfile } from "../types/aster";
import { updateProfile } from "../services/aster/commands";
import { dbConfigure, dbStatus, dbSync, dbSyncConversations, type DbStatus } from "../services/aster/db";
import { loadHistory } from "../services/history/store";
import {
  DEFAULT_SPEECH_POLICY,
  describePolicy,
  loadSpeechPolicy,
  saveSpeechPolicy,
  type SpeechPolicy,
} from "../services/speech/policy";
import { clearHistory, historySize } from "../services/history/store";

interface DataPolicyProps {
  profile: UserProfile | null;
  onSaved: () => void;
}

/** Interruptor etiquetado. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm text-aster-text">{label}</span>
        {hint && <span className="block text-[11px] text-aster-muted">{hint}</span>}
      </span>
      <button
        onClick={() => onChange(!checked)}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60 ${
          checked ? "bg-aster-accent" : "bg-aster-surface2"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </li>
  );
}

export function DataPolicy({ profile, onSaved }: DataPolicyProps) {
  const [speech, setSpeech] = useState<SpeechPolicy>(loadSpeechPolicy());
  const [retention, setRetention] = useState(profile?.retentionDays ?? 30);
  const [size, setSize] = useState(historySize());
  const [notice, setNotice] = useState("");
  const [mongo, setMongo] = useState<DbStatus | null>(null);
  const [mongoUri, setMongoUri] = useState("");
  const [mongoDb, setMongoDb] = useState("aster");
  const [mongoBusy, setMongoBusy] = useState(false);

  useEffect(() => {
    setSpeech(loadSpeechPolicy());
    setRetention(profile?.retentionDays ?? 30);
  }, [profile]);

  useEffect(() => {
    void dbStatus().then((s) => {
      setMongo(s);
      setMongoDb(s.dbName || "aster");
    }).catch(() => undefined);
  }, []);

  const patch = (next: Partial<SpeechPolicy>) => {
    const merged = { ...speech, ...next };
    saveSpeechPolicy(merged);
    setSpeech(merged);
    setSize(historySize());
  };

  const patchProfile = async (next: { retentionDays?: number }) => {
    try {
      await updateProfile(next);
      onSaved();
      setNotice("Política de retención actualizada.");
    } catch (error) {
      setNotice(`No se pudo guardar: ${(error as Error).message}`);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Voz
        </h3>
        <ul className="mt-2 space-y-1.5">
          <li className="rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
            <span className="block text-sm text-aster-text">Motor de reconocimiento (STT)</span>
            <select
              value={speech.sttEngine}
              onChange={(e) => patch({ sttEngine: e.currentTarget.value as SpeechPolicy["sttEngine"] })}
              className="mt-1.5 w-full rounded-lg border border-aster-border bg-aster-surface px-3 py-2 text-sm text-aster-text focus:border-aster-accent focus:outline-none"
            >
              <option value="auto">Automático: local y, si falla, nube</option>
              <option value="local">Solo local (sin enviar audio)</option>
              <option value="cloud">Priorizar transcripción en la nube</option>
            </select>
          </li>
          <li className="rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
            <label className="block text-sm text-aster-text" htmlFor="stt-lang">
              Idioma de la voz
            </label>
            <input
              id="stt-lang"
              value={speech.sttLang}
              onChange={(e) => patch({ sttLang: e.currentTarget.value })}
              className="mt-1.5 w-full rounded-lg border border-aster-border bg-aster-surface px-3 py-2 text-sm text-aster-text focus:border-aster-accent focus:outline-none"
            />
          </li>
          <Toggle
            label="Transcripción en la nube"
            hint="Si está desactivada y no hay motor local, Aster pedirá la orden escrita."
            checked={speech.cloudSttEnabled && speech.sttEngine !== "local"}
            disabled={speech.sttEngine === "local"}
            onChange={(next) => patch({ cloudSttEnabled: next })}
          />
          <Toggle
            label="Leer las respuestas en voz alta (TTS)"
            hint="Síntesis local con las voces instaladas en el sistema."
            checked={speech.ttsEnabled}
            onChange={(next) => patch({ ttsEnabled: next })}
          />
          <li className="rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
            <span className="block text-sm text-aster-text">Velocidad de la voz</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={speech.ttsRate}
              onChange={(e) => patch({ ttsRate: Number(e.currentTarget.value) })}
              className="mt-2 w-full accent-aster-accent"
            />
          </li>
        </ul>
        <p className="mt-2 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-[11px] text-emerald-200">
          <strong>Grabaciones de voz: no se almacenan.</strong> El audio se mantiene solo en memoria
          mientras se transcribe y se descarta inmediatamente después. No hay ninguna copia en disco
          ni en la nube.
        </p>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Almacenamiento del historial
        </h3>
        <ul className="mt-2 space-y-1.5">
          <Toggle
            label="Conservar el historial de conversaciones"
            hint="Solo texto, en este dispositivo."
            checked={speech.storeConversation}
            onChange={(next) => {
              patch({ storeConversation: next });
              if (!next) {
                clearHistory();
                setSize(historySize());
              }
            }}
          />
          <li className="rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
            <span className="block text-sm text-aster-text">Mensajes conservados</span>
            <input
              type="range"
              min={10}
              max={1000}
              step={10}
              value={speech.conversationLimit}
              onChange={(e) => patch({ conversationLimit: Number(e.currentTarget.value) })}
              className="mt-2 w-full accent-aster-accent"
            />
          </li>
          <li className="rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
            <span className="block text-sm text-aster-text">
              Días de retención del historial de acciones
            </span>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={365}
                step={1}
                value={retention}
                aria-label="Días de retención del historial de acciones"
                onChange={(e) => setRetention(Number(e.currentTarget.value))}
                onMouseUp={() => void patchProfile({ retentionDays: retention })}
                onTouchEnd={() => void patchProfile({ retentionDays: retention })}
                onKeyUp={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    void patchProfile({ retentionDays: retention });
                  }
                }}
                onBlur={() => void patchProfile({ retentionDays: retention })}
                className="flex-1 accent-aster-accent"
              />
              <span className="w-14 text-right text-sm text-aster-text">{retention} d</span>
            </div>
            <p className="mt-1 text-[11px] text-aster-muted">
              Las entradas más antiguas del registro de auditoría se podan solas.
            </p>
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Nube (Mongo Atlas)
        </h3>
        <div className="mt-2 space-y-1.5 rounded-xl border border-aster-border bg-aster-bg px-3 py-2">
          <p className="text-[11px] text-aster-muted">
            {mongo ? mongo.detail : "Consultando estado de Atlas…"}
            {mongo?.connected && <span className="ml-1 text-emerald-300">● Atlas</span>}
            {mongo && !mongo.connected && <span className="ml-1 text-amber-300">● Local</span>}
          </p>
          {mongo && mongo.uriSource !== "none" && (
            <p className="font-mono text-[11px] text-aster-muted">
              Origen: {mongo.uriSource === "env" ? ".env" : "Ajustes (este equipo)"} ·{" "}
              {mongo.uriPreview}
            </p>
          )}
          <label className="block text-sm text-aster-text" htmlFor="mongo-uri">
            Connection string (mongodb+srv://…)
          </label>
          <input
            id="mongo-uri"
            type="password"
            autoComplete="off"
            placeholder="mongodb+srv://aster-app:***@cluster0.xxxxx.mongodb.net/"
            value={mongoUri}
            onChange={(e) => setMongoUri(e.currentTarget.value)}
            className="w-full rounded-lg border border-aster-border bg-aster-surface px-3 py-2 font-mono text-xs text-aster-text focus:border-aster-accent focus:outline-none"
          />
          <div className="flex gap-2">
            <input
              aria-label="Base de datos"
              value={mongoDb}
              onChange={(e) => setMongoDb(e.currentTarget.value)}
              className="w-36 rounded-lg border border-aster-border bg-aster-surface px-3 py-2 text-sm text-aster-text focus:border-aster-accent focus:outline-none"
            />
            <button
              disabled={mongoBusy}
              onClick={async () => {
                setMongoBusy(true);
                try {
                  const s = await dbConfigure({ uri: mongoUri || null, dbName: mongoDb || "aster", enabled: true });
                  setMongo(s);
                  setMongoUri("");
                  setNotice(s.connected ? "Atlas conectado." : `Guardado. ${s.detail}`);
                } catch (e) {
                  setNotice(`No se pudo guardar: ${(e as Error).message}`);
                } finally {
                  setMongoBusy(false);
                }
              }}
              className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-text transition hover:bg-aster-surface2 disabled:opacity-60"
            >
              Guardar
            </button>
            <button
              disabled={mongoBusy}
              onClick={async () => {
                setMongoBusy(true);
                try {
                  const r = await dbSync();
                  const c = await dbSyncConversations(loadHistory());
                  const s = await dbStatus();
                  setMongo(s);
                  setNotice(`Migrado: ${r.pushedAudits}/${r.audits} auditoría · ${r.pushedMetrics}/${r.metrics} métricas · ${c.pushed}/${c.received} conversaciones → ${r.db}.`);
                } catch (e) {
                  setNotice(`Migración falló: ${(e as Error).message}`);
                } finally {
                  setMongoBusy(false);
                }
              }}
              className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-text transition hover:bg-aster-surface2 disabled:opacity-60"
            >
              Migrar ahora
            </button>
            <button
              disabled={mongoBusy}
              onClick={async () => {
                try {
                  const s = await dbConfigure({ uri: "", enabled: false });
                  setMongo(s);
                  setNotice("Atlas desactivado: modo solo local.");
                } catch (e) {
                  setNotice(`No se pudo desactivar: ${(e as Error).message}`);
                }
              }}
              className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
            >
              Solo local
            </button>
          </div>
          <p className="text-[11px] text-aster-muted">
            Híbrido: siempre se escribe en local primero; Atlas es espejo. La URI se guarda solo
            en este equipo (`.env` o `db_config.json`), nunca se sube al repo. Si el campo está
            vacío al guardar, se conserva la actual.
          </p>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Resumen de la política vigente
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-aster-muted">
          {describePolicy(speech).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              clearHistory();
              setSize(historySize());
              setNotice("Historial de conversaciones borrado.");
            }}
            className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Borrar conversaciones ({size.sessions} · {(size.bytes / 1024).toFixed(1)} KB)
          </button>
          <button
            onClick={() => patch({ ...DEFAULT_SPEECH_POLICY })}
            className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Restablecer política de voz
          </button>
        </div>
      </section>

      {notice && <p className="text-xs text-aster-accent2">{notice}</p>}
    </div>
  );
}
