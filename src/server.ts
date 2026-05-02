import 'dotenv/config';

import express, { Request, Response } from 'express';
import {
    createLinkToken,
    exchangePublicToken,
    syncHoldingsForItem,
} from './plaidService.js';

const app = express();
app.use(express.json());

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

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`OptionsAI server listening on port ${port}`);
});
