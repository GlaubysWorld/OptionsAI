require('dotenv').config();

const express = require('express');
const {
    createLinkToken,
    exchangePublicToken,
    syncHoldingsForItem,
} = require('./plaidService');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({ ok: true, env: process.env.PLAID_ENV || 'sandbox' });
});

app.post('/plaid/link-token', async (req, res) => {
    try {
        const { user_id } = req.body || {};
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });
        const data = await createLinkToken(user_id);
        res.json(data);
    } catch (err) {
        console.error('[link-token]', err.response?.data || err);
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

app.post('/plaid/exchange-public-token', async (req, res) => {
    try {
        const { public_token, user_id } = req.body || {};
        if (!public_token)
            return res.status(400).json({ error: 'public_token is required' });
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });

        const result = await exchangePublicToken({
            publicToken: public_token,
            userId: user_id,
        });
        res.json({ item_id: result.itemId, accounts: result.accounts });
    } catch (err) {
        console.error('[exchange-public-token]', err.response?.data || err);
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

app.post('/plaid/holdings/sync', async (req, res) => {
    try {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id is required' });
        const result = await syncHoldingsForItem(item_id);
        res.json(result);
    } catch (err) {
        console.error('[holdings/sync]', err.response?.data || err);
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`OptionsAI server listening on port ${port}`);
});
