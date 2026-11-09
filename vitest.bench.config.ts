/**
 * Configuración de la batería de benchmarks de frontend.
 *
 * Se ejecuta con `npm run bench` (no con `npm test`). Solo incluye los archivos
 * `*.bench.ts`, usa un único hilo para reducir ruido y da margen de sobra para
 * los benches asíncronos del controlador.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.bench.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
