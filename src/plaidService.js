const { Products, CountryCode } = require('plaid');
const { plaidClient } = require('./plaidClient');
const { supabase } = require('./supabaseClient');

const parseList = (value, fallback) =>
    (value || fallback)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const productsFromEnv = () =>
    parseList(process.env.PLAID_PRODUCTS, 'investments').map((p) => Products[p] || p);

const countryCodesFromEnv = () =>
    parseList(process.env.PLAID_COUNTRY_CODES, 'US').map((c) => CountryCode[c] || c);

async function createLinkToken(userId) {
    const request = {
        user: { client_user_id: String(userId) },
        client_name: 'OptionsAI',
        products: productsFromEnv(),
        country_codes: countryCodesFromEnv(),
        language: 'en',
    };

    const redirectUri = process.env.PLAID_REDIRECT_URI;
    if (redirectUri) request.redirect_uri = redirectUri;

    const response = await plaidClient.linkTokenCreate(request);
    return response.data;
}

async function exchangePublicToken({ publicToken, userId }) {
    const exchange = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
    });

    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    const accountsResp = await plaidClient.accountsGet({ access_token: accessToken });
    const item = accountsResp.data.item;

    let institution = { institution_id: item.institution_id, name: null };
    if (item.institution_id) {
        try {
            const inst = await plaidClient.institutionsGetById({
                institution_id: item.institution_id,
                country_codes: countryCodesFromEnv(),
            });
            institution.name = inst.data.institution.name;
        } catch (err) {
            console.warn('[plaid] institutionsGetById failed:', err.message);
        }
    }

    const rows = accountsResp.data.accounts.map((account) => ({
        user_id: userId,
        plaid_item_id: itemId,
        plaid_account_id: account.account_id,
        plaid_access_token: accessToken,
        institution_id: institution.institution_id,
        institution_name: institution.name,
        name: account.name,
        official_name: account.official_name,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype,
        updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
        .from('accounts')
        .upsert(rows, { onConflict: 'plaid_account_id' })
        .select();

    if (error) throw new Error(`Supabase accounts upsert failed: ${error.message}`);

    return { itemId, accessToken, accounts: data };
}

async function syncHoldings({ accessToken, itemId }) {
    const response = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
    const { holdings, securities, accounts } = response.data;

    const securityById = new Map(securities.map((s) => [s.security_id, s]));

    const { data: dbAccounts, error: lookupError } = await supabase
        .from('accounts')
        .select('id, plaid_account_id')
        .eq('plaid_item_id', itemId);

    if (lookupError)
        throw new Error(`Supabase accounts lookup failed: ${lookupError.message}`);

    const accountIdByPlaidId = new Map(
        (dbAccounts || []).map((a) => [a.plaid_account_id, a.id]),
    );

    const rows = holdings
        .map((holding) => {
            const security = securityById.get(holding.security_id) || {};
            const accountId = accountIdByPlaidId.get(holding.account_id);
            if (!accountId) return null;
            return {
                account_id: accountId,
                plaid_account_id: holding.account_id,
                security_id: holding.security_id,
                ticker_symbol: security.ticker_symbol,
                name: security.name,
                type: security.type,
                cusip: security.cusip,
                isin: security.isin,
                quantity: holding.quantity,
                institution_price: holding.institution_price,
                institution_price_as_of: holding.institution_price_as_of,
                institution_value: holding.institution_value,
                cost_basis: holding.cost_basis,
                iso_currency_code: holding.iso_currency_code,
                unofficial_currency_code: holding.unofficial_currency_code,
                synced_at: new Date().toISOString(),
            };
        })
        .filter(Boolean);

    if (rows.length === 0) return { count: 0, holdings: [], accounts };

    const { data, error } = await supabase
        .from('holdings')
        .upsert(rows, { onConflict: 'plaid_account_id,security_id' })
        .select();

    if (error) throw new Error(`Supabase holdings upsert failed: ${error.message}`);

    return { count: data.length, holdings: data, accounts };
}

async function syncHoldingsForItem(itemId) {
    const { data, error } = await supabase
        .from('accounts')
        .select('plaid_access_token')
        .eq('plaid_item_id', itemId)
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Supabase access token lookup failed: ${error.message}`);
    if (!data) throw new Error(`No account found for plaid_item_id ${itemId}`);

    return syncHoldings({ accessToken: data.plaid_access_token, itemId });
}

module.exports = {
    createLinkToken,
    exchangePublicToken,
    syncHoldings,
    syncHoldingsForItem,
};
