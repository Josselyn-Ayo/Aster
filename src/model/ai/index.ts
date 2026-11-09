/**
 * API pública del modelo de IA. El Controlador y las Vistas importan solo
 * desde aquí, nunca desde los adaptadores concretos.
 */
export {
  chat,
  captureScreen,
  describeScreen,
  generateImage,
  interpret,
  isQuotaError,
  fastRoute,
  parseRoutedIntent,
  setSystemPrompt,
  transcribeAudio,
  webSearch,
} from "./service";
export type { Intent, RoutedIntent, RoutingContext } from "./service";

export {
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  LEGACY_STORAGE_KEY,
  isProviderId,
  loadAiConfig,
  providerCredentials,
  resetApiKeyCache,
  resolveApiKey,
  saveAiConfig,
} from "./config";

export { PROVIDERS, PROVIDER_IDS } from "./providers";
export { clearUsage, totalCallsToday, usageToday } from "./usage";
export { AiUnavailableError } from "./registry";
export { CAPABILITIES, CAPABILITY_LABELS } from "./types";
export type {
  AiConfig,
  AiProvider,
  Capability,
  ProviderCredentials,
  ProviderId,
  Route,
} from "./types";
