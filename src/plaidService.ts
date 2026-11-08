import {
    AccountBase,
    CountryCode,
    Holding,
    LinkTokenCreateRequest,
    LinkTokenCreateResponse,
    Products,
    Security,
} from 'plaid';
import { plaidClient } from './plaidClient.js';
import { supabase } from './supabaseClient.js';

interface AccountRow {
    id: string;
    user_id: string;
    plaid_item_id: string | null;
    plaid_account_id: string | null;
    plaid_access_token: string | null;
    institution_name: string | null;
    account_name: string | null;
    account_type: string;
    currency: string;
    is_active: boolean;
    synced_at: string | null;
    created_at: string;
    updated_at: string;
}

interface HoldingRow {
    id: string;
    user_id: string;
    account_id: string;
    symbol: string;
    security_name: string | null;
    asset_class: string;
    quantity: number;
    cost_basis: number | null;
    cost_basis_per_share: number | null;
    current_price: number | null;
    current_value: number | null;
    unrealized_pnl: number | null;
    unrealized_pnl_pct: number | null;
    last_price_at: string | null;
    created_at: string;
    updated_at: string;
}

const normalize = (s: string | null | undefined): string =>
    (s ?? '').toString().toLowerCase().replace(/\s+/g, '_');

function mapAccountType(account: AccountBase): string {
    const subtype = normalize(account.subtype);
    if (subtype === '401k') return '401k';
    if (subtype === 'roth' || subtype === 'roth_ira') return 'roth_ira';
    if (subtype === 'ira') return 'ira';
    if (subtype === 'brokerage') return 'brokerage';
    if (subtype === 'crypto_exchange' || subtype === 'crypto') return 'crypto';

    const type = normalize(account.type);
    if (type === 'investment') return 'brokerage';
    if (type === 'depository') return 'cash';
    return 'other';
}

function mapAssetClass(security: Security | undefined): string {
    const t = normalize(security?.type);
    if (t === 'equity') return 'equity';
    if (t === 'etf') return 'etf';
    if (t === 'mutual_fund') return 'mutual_fund';
    if (t === 'fixed_income' || t === 'bond') return 'bond';
    if (t === 'derivative' || t === 'option') return 'option';
    if (t === 'cryptocurrency' || t === 'crypto') return 'crypto';
    if (t === 'cash') return 'cash';
    return 'other';
}

// Plaid securities don't always have a ticker. The DB requires a non-null
// `symbol`, so fall back to CUSIP / ISIN / security_id in that order.
function resolveSymbol(security: Security | undefined, holding: Holding): string {
    return (
        security?.ticker_symbol?.trim() ||
        security?.cusip ||
        security?.isin ||
        holding.security_id
    );
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

    let institutionName: string | null = null;
    if (item.institution_id) {
        try {
            const inst = await plaidClient.institutionsGetById({
                institution_id: item.institution_id,
                country_codes: countryCodesFromEnv(),
            });
            institutionName = inst.data.institution.name;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[plaid] institutionsGetById failed:', message);
        }
    }

    const now = new Date().toISOString();
    const rows = accountsResp.data.accounts.map((account) => ({
        user_id: userId,
        plaid_item_id: itemId,
        plaid_account_id: account.account_id,
        plaid_access_token: accessToken,
        institution_name: institutionName,
        account_name: account.official_name ?? account.name ?? null,
        account_type: mapAccountType(account),
        currency: account.balances?.iso_currency_code ?? 'USD',
        is_active: true,
        synced_at: now,
        updated_at: now,
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
        .select('id, user_id, plaid_account_id')
        .eq('plaid_item_id', itemId);

    if (lookupError)
        throw new Error(`Supabase accounts lookup failed: ${lookupError.message}`);

    type DbAccount = { id: string; user_id: string; plaid_account_id: string | null };
    const accountByPlaidId = new Map<string, DbAccount>(
        ((dbAccounts ?? []) as DbAccount[])
            .filter((a) => a.plaid_account_id)
            .map((a) => [a.plaid_account_id as string, a]),
    );

    const now = new Date().toISOString();
    const rows = holdings
        .map((holding) => {
            const security = securityById.get(holding.security_id);
            const account = accountByPlaidId.get(holding.account_id);
            if (!account) return null;

            const quantity = holding.quantity ?? 0;
            const currentPrice = holding.institution_price ?? null;
            const currentValue =
                holding.institution_value ??
                (currentPrice != null ? quantity * currentPrice : null);
            const costBasis = holding.cost_basis ?? null;
            const costBasisPerShare =
                costBasis != null && quantity ? costBasis / quantity : null;
            const unrealizedPnl =
                currentValue != null && costBasis != null
                    ? currentValue - costBasis
                    : null;
            const unrealizedPnlPct =
                unrealizedPnl != null && costBasis ? (unrealizedPnl / costBasis) * 100 : null;

            return {
                user_id: account.user_id,
                account_id: account.id,
                symbol: resolveSymbol(security, holding),
                security_name: security?.name ?? null,
                asset_class: mapAssetClass(security),
                quantity,
                cost_basis: costBasis,
                cost_basis_per_share: costBasisPerShare,
                current_price: currentPrice,
                current_value: currentValue,
                unrealized_pnl: unrealizedPnl,
                unrealized_pnl_pct: unrealizedPnlPct,
                last_price_at: holding.institution_price_as_of
                    ? new Date(holding.institution_price_as_of).toISOString()
                    : null,
                updated_at: now,
            };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) return { count: 0, holdings: [], accounts };

    const { data, error } = await supabase
        .from('holdings')
        .upsert(rows, { onConflict: 'account_id,symbol' })
        .select();

    if (error) throw new Error(`Supabase holdings upsert failed: ${error.message}`);

    return { count: data?.length ?? 0, holdings: (data ?? []) as HoldingRow[], accounts };
}

export async function syncHoldingsForItem(itemId: string): Promise<SyncResult> {
    const { data, error } = await supabase
        .from('accounts')
        .select('plaid_access_token')
        .eq('plaid_item_id', itemId)
        .not('plaid_access_token', 'is', null)
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Supabase access token lookup failed: ${error.message}`);
    if (!data) throw new Error(`No account found for plaid_item_id ${itemId}`);

    return syncHoldings({
        accessToken: (data as { plaid_access_token: string }).plaid_access_token,
        itemId,
    });
}
