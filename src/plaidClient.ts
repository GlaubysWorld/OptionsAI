import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const env = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;

const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
            'PLAID-SECRET': process.env.PLAID_SECRET,
            'Plaid-Version': '2020-09-14',
        },
    },
});

export const plaidClient = new PlaidApi(configuration);
