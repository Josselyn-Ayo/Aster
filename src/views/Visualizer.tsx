/**
 * Visualizer: el Orb de partículas de ASTER.
 * Esfera de 1200 partículas renderizada en un canvas que reacciona al estado
 * del asistente:
 *  - `idle`      : orb sereno y reposado (rotación lenta, sin pulso).
 *  - `listening` / `processing` / `speaking`: orb activo que se contrae,
 *    acelera la rotación y pulsa con un nivel de audio simulado.
 */
import { useEffect, useRef } from "react";
import type { ListeningState } from "../types";
import DecryptedText from "./bits/DecryptedText";

interface VisualizerProps {
  state: ListeningState;
  greeting?: string;
}

const STATE_LABELS: Record<ListeningState, string> = {
  idle: "En espera",
  listening: "Escuchando…",
  processing: "Procesando…",
  speaking: "Hablando…",
};

const SIZE = 420;

function lerp(a: number, b: number, amount: number) {
  return a + (b - a) * amount;
}

export function Visualizer({ state, greeting }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const center = SIZE / 2;

    // Movimiento reducido: un fotograma estático, sin rAF ni intervalos.
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- Partículas de la esfera ---
    const particles: Array<{
      x: number;
      y: number;
      z: number;
      size: number;
      alpha: number;
      phase: number;
      speed: number;
    }> = [];

    const PARTICLES = reducedMotion ? 250 : 800;
    for (let i = 0; i < PARTICLES; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const base = 125 + Math.random() * 45;
      particles.push({
        x: base * Math.sin(phi) * Math.cos(theta),
        y: base * Math.sin(phi) * Math.sin(theta),
        z: base * Math.cos(phi),
        size: Math.random() * 1.8 + 0.3,
        alpha: Math.random() * 0.8 + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.02 + 0.005,
      });
    }

    // --- Estado interno del orb ---
    let active = 0; // 0..1 suavizado (idle -> activo)
    const targetActive = state === "idle" ? 0 : 1;

    let scale = 1;
    let targetScale = 1;

    let rotation = 0;

    let audioLevel = 0;
    let targetAudioLevel = 0;

    let pulseTimer: number | null = null;

    // Pulsos de audio simulados mientras el orb está activo.
    const startPulse = () => {
      if (pulseTimer !== null) return;
      pulseTimer = window.setInterval(() => {
        if (targetActive > 0.5) {
          targetAudioLevel = Math.random() * 0.9;
        }
      }, 80);
    };

    const stopPulse = () => {
      if (pulseTimer !== null) {
        window.clearInterval(pulseTimer);
        pulseTimer = null;
      }
    };

    startPulse();

    let raf = 0;
    let hidden = document.hidden;
    const onVisibility = () => {
      hidden = document.hidden;
      // Al volver, se reanuda el bucle (si estaba pausado no hay rAF vivo).
      if (!hidden && !reducedMotion) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(animate);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const drawFrame = () => {
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Transición suave entre quieto y activo.
      active = lerp(active, targetActive, 0.06);

      targetScale = lerp(1, 0.68, active);
      scale = lerp(scale, targetScale, 0.08);

      rotation += lerp(0.0025, 0.018, active);

      audioLevel = lerp(audioLevel, targetAudioLevel, 0.15);
      targetAudioLevel *= 0.9;

      // --- Aura ---
      const aura = 170 * scale + audioLevel * (45 * active);
      const gradient = ctx.createRadialGradient(center, center, 10, center, center, aura);
      gradient.addColorStop(0, "rgba(214,51,132,0.25)");
      gradient.addColorStop(0.4, "rgba(240,180,41,0.10)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(center, center, aura, 0, Math.PI * 2);
      ctx.fill();

      // --- Partículas ---
      particles.forEach((p) => {
        const time = Date.now() * p.speed;

        const movement = lerp(0.7, 3 + audioLevel * 10, active);

        const x = p.x + Math.sin(time + p.phase) * movement;
        const y = p.y + Math.cos(time + p.phase) * movement;
        const z = p.z;

        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const rotatedX = x * cos - z * sin;
        const rotatedZ = x * sin + z * cos;

        const finalX = rotatedX * scale;
        const finalY = y * scale;
        const finalZ = rotatedZ;

        const depth = (finalZ + 180) / 360;
        const perspective = 0.65 + depth * 0.55;

        const screenX = center + finalX * perspective;
        const screenY = center + finalY * perspective;

        let size = p.size * perspective;
        size *= 1 + audioLevel * 1.5 * active;

        let alpha = p.alpha * (0.35 + depth * 0.65);
        alpha += audioLevel * 0.35 * active;

        ctx.beginPath();
        ctx.arc(screenX, screenY, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240,97,168,${alpha})`;
        ctx.shadowBlur = lerp(6, 12, active);
        ctx.shadowColor = "#d63384";
        ctx.fill();
      });

      ctx.shadowBlur = 0;
    };

    // Bucle: dibuja y solo encadena el siguiente frame si la ventana está
    // visible (con la ventana oculta no se gasta CPU ni batería).
    const animate = () => {
      drawFrame();
      if (!reducedMotion && !hidden) {
        raf = requestAnimationFrame(animate);
      } else {
        raf = 0;
      }
    };

    drawFrame();
    if (!reducedMotion && !hidden) {
      raf = requestAnimationFrame(animate);
    }

    return () => {
      stopPulse();
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [state]);

  return (
    <div className="relative flex shrink-0 flex-col items-center justify-center gap-1 px-4 py-2">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ width: "clamp(120px, 26vh, 240px)", height: "auto", aspectRatio: "1 / 1" }}
        className="block max-w-full"
      />
      <DecryptedText
        key={state}
        text={STATE_LABELS[state]}
        animateOn="view"
        sequential
        speed={30}
        maxIterations={12}
        className="text-aster-muted"
        encryptedClassName="text-aster-accent3"
        parentClassName="text-xs font-medium uppercase tracking-widest"
      />
      {greeting && <p className="max-w-sm text-center text-sm text-aster-muted">{greeting}</p>}
    </div>
  );
}
