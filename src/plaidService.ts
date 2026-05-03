import {
    AccountSubtype,
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
    plaid_account_id: string | null;
    plaid_item_id: string | null;
    institution_name: string;
    account_name: string;
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

// account_type and asset_class in the existing schema are CHECK-constrained
// enums. Plaid's vocabulary is wider, so map common cases and fall back.
const ACCOUNT_TYPE_MAP: Record<string, string> = {
    brokerage: 'brokerage',
    'non-taxable brokerage account': 'brokerage',
    ira: 'ira',
    'sep ira': 'ira',
    'simple ira': 'ira',
    roth: 'roth_ira',
    'roth 401k': 'roth_ira',
    '401k': '401k',
    '401a': '401k',
    '403b': '401k',
    '457b': '401k',
    'thrift savings plan': '401k',
    pension: '401k',
    'crypto exchange': 'crypto',
    'non-custodial wallet': 'crypto',
    'cash management': 'cash',
    cd: 'cash',
    'money market': 'cash',
};

const ASSET_CLASS_MAP: Record<string, string> = {
    equity: 'equity',
    etf: 'etf',
    'mutual fund': 'mutual_fund',
    'fixed income': 'bond',
    derivative: 'option',
    cash: 'cash',
    cryptocurrency: 'crypto',
};

function mapAccountType(subtype: AccountSubtype | string | null | undefined): string {
    if (!subtype) return 'other';
    return ACCOUNT_TYPE_MAP[String(subtype).toLowerCase()] ?? 'other';
}

function mapAssetClass(securityType: string | null | undefined): string {
    if (!securityType) return 'other';
    return ASSET_CLASS_MAP[securityType.toLowerCase()] ?? 'other';
}

const safeDivide = (numerator: number | null, denominator: number | null): number | null => {
    if (numerator == null || denominator == null) return null;
    if (denominator === 0) return null;
    return numerator / denominator;
};

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

    let institutionName = 'Unknown Institution';
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

    const nowIso = new Date().toISOString();
    const rows = accountsResp.data.accounts.map((account) => ({
        user_id: userId,
        plaid_account_id: account.account_id,
        plaid_item_id: itemId,
        plaid_access_token: accessToken,
        institution_name: institutionName,
        account_name: account.name ?? account.official_name ?? 'Account',
        account_type: mapAccountType(account.subtype),
        currency:
            account.balances.iso_currency_code ??
            account.balances.unofficial_currency_code ??
            'USD',
        is_active: true,
        synced_at: nowIso,
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

    const accountByPlaidId = new Map<string, { id: string; user_id: string }>(
        (
            (dbAccounts ?? []) as Array<{
                id: string;
                user_id: string;
                plaid_account_id: string;
            }>
        ).map((a) => [a.plaid_account_id, { id: a.id, user_id: a.user_id }]),
    );

    const rows = holdings
        .map((holding) => {
            const security = securityById.get(holding.security_id);
            const account = accountByPlaidId.get(holding.account_id);
            if (!account) return null;

            // symbol is NOT NULL in the schema. Plaid omits ticker for some
            // exotic securities, so fall back to cusip / isin / security_id.
            const symbol =
                security?.ticker_symbol ??
                security?.cusip ??
                security?.isin ??
                holding.security_id;

            const costBasis = holding.cost_basis ?? null;
            const quantity = holding.quantity;
            const currentPrice = holding.institution_price ?? null;
            const currentValue = holding.institution_value ?? null;

            const costBasisPerShare =
                costBasis != null && quantity > 0 ? costBasis / quantity : null;
            const unrealizedPnl =
                currentValue != null && costBasis != null
                    ? currentValue - costBasis
                    : null;
            const unrealizedPnlPctRaw = safeDivide(
                unrealizedPnl != null ? unrealizedPnl * 100 : null,
                costBasis,
            );
            // holdings.unrealized_pnl_pct is numeric(10,4), so 999,999.9999 is
            // the max representable value. Plaid sandbox occasionally returns
            // tiny cost_basis values that produce overflowing percentages; in
            // those cases we drop to null rather than crash the whole upsert.
            const unrealizedPnlPct =
                unrealizedPnlPctRaw != null && Math.abs(unrealizedPnlPctRaw) <= 999_999.9999
                    ? unrealizedPnlPctRaw
                    : null;

            return {
                user_id: account.user_id,
                account_id: account.id,
                symbol,
                security_name: security?.name ?? null,
                asset_class: mapAssetClass(security?.type),
                quantity,
                cost_basis: costBasis,
                cost_basis_per_share: costBasisPerShare,
                current_price: currentPrice,
                current_value: currentValue,
                unrealized_pnl: unrealizedPnl,
                unrealized_pnl_pct: unrealizedPnlPct,
                last_price_at: holding.institution_price_as_of ?? null,
            };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) return { count: 0, holdings: [], accounts };

    const { data, error } = await supabase
        .from('holdings')
        .upsert(rows, { onConflict: 'account_id,symbol' })
        .select();

    if (error) throw new Error(`Supabase holdings upsert failed: ${error.message}`);

    const accountIds = Array.from(new Set(rows.map((r) => r.account_id)));
    if (accountIds.length > 0) {
        await supabase
            .from('accounts')
            .update({ synced_at: new Date().toISOString() })
            .in('id', accountIds);
    }

    return { count: data?.length ?? 0, holdings: (data ?? []) as HoldingRow[], accounts };
}

export async function syncHoldingsForItem(itemId: string): Promise<SyncResult> {
    // plaid_access_token is column-level revoked from anon/authenticated; only
    // the service-role key used here can read it.
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
