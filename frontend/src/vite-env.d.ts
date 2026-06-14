/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENOKI_API_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_SUI_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
