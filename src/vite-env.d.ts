/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Clave de Gemini inyectada por Vite (solo desarrollo en navegador). */
  readonly VITE_GEMINI_API_KEY?: string;
  /** Clave de Groq inyectada por Vite (solo desarrollo en navegador). */
  readonly VITE_GROQ_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
