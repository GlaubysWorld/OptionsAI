import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (cached) return cached;

    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
        throw new Error(
            'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set before using Supabase.',
        );
    }

    cached = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return cached;
}

export const supabase = new Proxy({} as SupabaseClient, {
    get(_target, prop: string | symbol) {
        const client = getSupabase() as unknown as Record<string | symbol, unknown>;
        const value = client[prop];
        return typeof value === 'function' ? (value as Function).bind(client) : value;
    },
});

// Per-request client that runs as the signed-in user (role=authenticated)
// using the anon key + the user's JWT. RLS policies enforce ownership; the
// column-level grant on accounts keeps plaid_access_token unreadable.
export function createUserClient(jwt: string): SupabaseClient {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
        throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
    }
    return createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
}
