declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LLM_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    IMAGE_MODEL?: string;
    IMAGE_BASE_URL?: string;
    IMAGE_API_KEY?: string;
    PROVIDER_SETTINGS_SECRET?: string;
  }
}
