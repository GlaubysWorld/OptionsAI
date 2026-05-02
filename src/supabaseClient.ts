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
