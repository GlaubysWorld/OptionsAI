const { createClient } = require('@supabase/supabase-js');

let cached = null;

function getSupabase() {
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

const supabase = new Proxy(
    {},
    {
        get(_target, prop) {
            const client = getSupabase();
            const value = client[prop];
            return typeof value === 'function' ? value.bind(client) : value;
        },
    },
);

module.exports = { supabase, getSupabase };
