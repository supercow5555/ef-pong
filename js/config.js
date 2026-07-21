// EF Pong — Supabase project config.
// The anon key is safe to ship in the browser: RLS + server-side functions
// are what actually protect the data.
export const SUPABASE_URL = 'https://yzpjlmdbblladznifktj.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_k39nfuPfzwW5MwhVC2jhyA_zs38cIY9';

// Sign-in providers to show on the login screen, in order. These must be
// ENABLED in Supabase → Auth → Providers or the button will error on click.
// Add 'azure' here once the Microsoft app registration is wired up.
// 'email' keeps the magic-link fallback available.
export const AUTH_PROVIDERS = ['google', 'email'];
