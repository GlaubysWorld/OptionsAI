import 'dotenv/config';

import express, { Request, Response } from 'express';
import {
    createLinkToken,
    exchangePublicToken,
    syncHoldingsForItem,
} from './plaidService.js';
import { createUserClient } from './supabaseClient.js';

const app = express();
app.use(express.json());

// Columns from public.accounts that authenticated/anon are granted SELECT on.
// plaid_access_token is intentionally excluded — only service_role can read it.
const ACCOUNT_PUBLIC_COLUMNS = [
    'id',
    'user_id',
    'plaid_account_id',
    'plaid_item_id',
    'institution_name',
    'account_name',
    'account_type',
    'currency',
    'is_active',
    'synced_at',
    'created_at',
    'updated_at',
].join(', ');

function extractBearerToken(req: Request): string | null {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1] : null;
}

interface PlaidErrorLike {
    message?: string;
    response?: { data?: unknown };
}

const errorPayload = (err: unknown) => {
    const e = err as PlaidErrorLike;
    return {
        error: e?.message ?? 'Unknown error',
        details: e?.response?.data,
    };
};

app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, env: process.env.PLAID_ENV ?? 'sandbox' });
});

app.post('/plaid/link-token', async (req: Request, res: Response) => {
    try {
        const { user_id } = (req.body ?? {}) as { user_id?: string };
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });
        const data = await createLinkToken(user_id);
        return res.json(data);
    } catch (err) {
        console.error('[link-token]', (err as PlaidErrorLike)?.response?.data ?? err);
        return res.status(500).json(errorPayload(err));
    }
});

app.post('/plaid/exchange-public-token', async (req: Request, res: Response) => {
    try {
        const { public_token, user_id } = (req.body ?? {}) as {
            public_token?: string;
            user_id?: string;
        };
        if (!public_token)
            return res.status(400).json({ error: 'public_token is required' });
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });

        const result = await exchangePublicToken({
            publicToken: public_token,
            userId: user_id,
        });
        return res.json({ item_id: result.itemId, accounts: result.accounts });
    } catch (err) {
        console.error(
            '[exchange-public-token]',
            (err as PlaidErrorLike)?.response?.data ?? err,
        );
        return res.status(500).json(errorPayload(err));
    }
});

app.post('/plaid/holdings/sync', async (req: Request, res: Response) => {
    try {
        const { item_id } = (req.body ?? {}) as { item_id?: string };
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });
        const result = await syncHoldingsForItem(item_id);
        return res.json(result);
    } catch (err) {
        console.error('[holdings/sync]', (err as PlaidErrorLike)?.response?.data ?? err);
        return res.status(500).json(errorPayload(err));
    }
});

app.get('/accounts', async (req: Request, res: Response) => {
    const jwt = extractBearerToken(req);
    if (!jwt) return res.status(401).json({ error: 'Authorization bearer token required' });

    try {
        const supa = createUserClient(jwt);
        const { data, error } = await supa
            .from('accounts')
            .select(ACCOUNT_PUBLIC_COLUMNS)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('[GET /accounts]', error);
            const status = error.code === 'PGRST301' || error.code === '401' ? 401 : 500;
            return res.status(status).json({ error: error.message });
        }
        return res.json({ accounts: data ?? [] });
    } catch (err) {
        console.error('[GET /accounts]', err);
        return res.status(500).json(errorPayload(err));
    }
});

app.get('/holdings', async (req: Request, res: Response) => {
    const jwt = extractBearerToken(req);
    if (!jwt) return res.status(401).json({ error: 'Authorization bearer token required' });

    try {
        const supa = createUserClient(jwt);
        const { data, error } = await supa
            .from('holdings')
            .select(
                '*, account:accounts!inner(institution_name, account_type)',
            )
            .order('current_value', { ascending: false, nullsFirst: false });

        if (error) {
            console.error('[GET /holdings]', error);
            const status = error.code === 'PGRST301' || error.code === '401' ? 401 : 500;
            return res.status(status).json({ error: error.message });
        }
        return res.json({ holdings: data ?? [] });
    } catch (err) {
        console.error('[GET /holdings]', err);
        return res.status(500).json(errorPayload(err));
    }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => {
    console.log(`OptionsAI server listening on ${host}:${port}`);
});
