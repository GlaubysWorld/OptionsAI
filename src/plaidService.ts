import {
    CountryCode,
    LinkTokenCreateRequest,
    LinkTokenCreateResponse,
    Products,
} from 'plaid';
import { plaidClient } from './plaidClient.js';
import { supabase } from './supabaseClient.js';

interface AccountRow {
    id: string;
    user_id: string;
    plaid_item_id: string;
    plaid_account_id: string;
    plaid_access_token: string;
    institution_id: string | null;
    institution_name: string | null;
    name: string | null;
    official_name: string | null;
    mask: string | null;
    type: string | null;
    subtype: string | null;
    created_at: string;
    updated_at: string;
}

interface HoldingRow {
    id: string;
    account_id: string;
    plaid_account_id: string;
    security_id: string;
    ticker_symbol: string | null;
    name: string | null;
    type: string | null;
    cusip: string | null;
    isin: string | null;
    quantity: number | null;
    institution_price: number | null;
    institution_price_as_of: string | null;
    institution_value: number | null;
    cost_basis: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
    synced_at: string;
}

const parseList = (value: string | undefined, fallback: string): string[] =>
    (value ?? fallback)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const productsFromEnv = (): Products[] =>
    parseList(process.env.PLAID_PRODUCTS, 'investments').map(
        (p) => (Products as Record<string, Products>)[p] ?? (p as Products),
    );

const countryCodesFromEnv = (): CountryCode[] =>
    parseList(process.env.PLAID_COUNTRY_CODES, 'US').map(
        (c) => (CountryCode as Record<string, CountryCode>)[c] ?? (c as CountryCode),
    );

export async function createLinkToken(userId: string): Promise<LinkTokenCreateResponse> {
    const request: LinkTokenCreateRequest = {
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

export interface ExchangeResult {
    itemId: string;
    accessToken: string;
    accounts: AccountRow[];
}

export async function exchangePublicToken(args: {
    publicToken: string;
    userId: string;
}): Promise<ExchangeResult> {
    const { publicToken, userId } = args;

    const exchange = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
    });

    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    const accountsResp = await plaidClient.accountsGet({ access_token: accessToken });
    const item = accountsResp.data.item;

    const institution: { institution_id: string | null; name: string | null } = {
        institution_id: item.institution_id ?? null,
        name: null,
    };
    if (item.institution_id) {
        try {
            const inst = await plaidClient.institutionsGetById({
                institution_id: item.institution_id,
                country_codes: countryCodesFromEnv(),
            });
            institution.name = inst.data.institution.name;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[plaid] institutionsGetById failed:', message);
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

    return { itemId, accessToken, accounts: (data ?? []) as AccountRow[] };
}

export interface SyncResult {
    count: number;
    holdings: HoldingRow[];
    accounts: unknown[];
}

export async function syncHoldings(args: {
    accessToken: string;
    itemId: string;
}): Promise<SyncResult> {
    const { accessToken, itemId } = args;

    const response = await plaidClient.investmentsHoldingsGet({
        access_token: accessToken,
    });
    const { holdings, securities, accounts } = response.data;

    const securityById = new Map(securities.map((s) => [s.security_id, s]));

    const { data: dbAccounts, error: lookupError } = await supabase
        .from('accounts')
        .select('id, plaid_account_id')
        .eq('plaid_item_id', itemId);

    if (lookupError)
        throw new Error(`Supabase accounts lookup failed: ${lookupError.message}`);

    const accountIdByPlaidId = new Map<string, string>(
        ((dbAccounts ?? []) as Array<{ id: string; plaid_account_id: string }>).map(
            (a) => [a.plaid_account_id, a.id],
        ),
    );

    const rows = holdings
        .map((holding) => {
            const security = securityById.get(holding.security_id);
            const accountId = accountIdByPlaidId.get(holding.account_id);
            if (!accountId) return null;
            return {
                account_id: accountId,
                plaid_account_id: holding.account_id,
                security_id: holding.security_id,
                ticker_symbol: security?.ticker_symbol ?? null,
                name: security?.name ?? null,
                type: security?.type ?? null,
                cusip: security?.cusip ?? null,
                isin: security?.isin ?? null,
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
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) return { count: 0, holdings: [], accounts };

    const { data, error } = await supabase
        .from('holdings')
        .upsert(rows, { onConflict: 'plaid_account_id,security_id' })
        .select();

    if (error) throw new Error(`Supabase holdings upsert failed: ${error.message}`);

    return { count: data?.length ?? 0, holdings: (data ?? []) as HoldingRow[], accounts };
}

export async function syncHoldingsForItem(itemId: string): Promise<SyncResult> {
    const { data, error } = await supabase
        .from('accounts')
        .select('plaid_access_token')
        .eq('plaid_item_id', itemId)
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Supabase access token lookup failed: ${error.message}`);
    if (!data) throw new Error(`No account found for plaid_item_id ${itemId}`);

    return syncHoldings({
        accessToken: (data as { plaid_access_token: string }).plaid_access_token,
        itemId,
    });
}
