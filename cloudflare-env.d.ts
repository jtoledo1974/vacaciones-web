declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LOCAL_ADMIN_USERNAME?: string;
    LOCAL_ADMIN_PASSWORD?: string;
    LOCAL_ADMIN_SESSION_SECRET?: string;
  }
}
