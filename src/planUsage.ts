import * as https from 'https';

const BASE = 'https://claude.ai';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface NormalizedUsage {
    sessionPercent: number | null;
    sessionResetAt: string | null;
    weeklyPercent: number | null;
    weeklyResetAt: string | null;
    sonnetPercent: number | null;
    sonnetResetAt: string | null;
    opusPercent: number | null;
    opusResetAt: string | null;
}

export interface UsageResult {
    source: string;
    normalized: NormalizedUsage;
}

export class AuthExpiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthExpiredError';
    }
}

// Cloudflare blocked the request (bot challenge) — this is NOT an expired Session Key.
// It happens when the request originates from a network stack with a non-browser TLS
// fingerprint (plain Node `https`), typically on a remote/headless extension host.
export class CloudflareBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudflareBlockedError';
    }
}

interface RawResponse {
    status: number;
    json: any | null;
    raw: string;
}

const HEADERS = (sessionCookie: string): Record<string, string> => ({
    Cookie: `sessionKey=${sessionCookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
    Referer: `${BASE}/`
});

// claude.ai sits behind Cloudflare, which fingerprints the TLS handshake and blocks
// plain Node `https` requests (returns a 403 "Just a moment..." challenge page). The VS
// Code extension host runs on Electron, whose `net` module uses Chromium's network stack
// and passes the challenge — so we use it when available and fall back to https otherwise.
let electronNet: any | undefined;
function getElectronNet(): any | null {
    if (electronNet !== undefined) return electronNet;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron');
        electronNet = electron && electron.net ? electron.net : null;
    } catch {
        electronNet = null;
    }
    return electronNet;
}

// Distinguish a Cloudflare bot challenge from a genuine API auth rejection. A challenge
// returns an HTML "Just a moment..." interstitial (or cf-mitigated/challenge-platform
// markers); a real expired Session Key returns a JSON/empty 401/403 from the origin.
function isCloudflareChallenge(status: number, body: string): boolean {
    if (status !== 403 && status !== 503 && status !== 429) return false;
    return /just a moment|challenge-platform|cf-chl|cdn-cgi\/challenge|_cf_chl|cf-mitigated/i.test(body);
}

function classify(status: number, body: string): RawResponse {
    if (status >= 200 && status < 300) {
        try {
            return { status, json: JSON.parse(body), raw: body };
        } catch {
            return { status, json: null, raw: body };
        }
    }
    if (isCloudflareChallenge(status, body)) {
        throw new CloudflareBlockedError(`Cloudflare challenge (HTTP ${status})`);
    }
    if (status === 401 || status === 403) {
        throw new AuthExpiredError(`Auth failed (HTTP ${status})`);
    }
    throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
}

function requestViaElectron(net: any, url: string, sessionCookie: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url, redirect: 'follow' });
        const headers = HEADERS(sessionCookie);
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
        let body = '';
        req.on('response', (res: any) => {
            res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
            res.on('end', () => {
                try {
                    resolve(classify(res.statusCode || 0, body));
                } catch (e) {
                    reject(e);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function requestViaHttps(url: string, sessionCookie: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: HEADERS(sessionCookie),
                timeout: 15000
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk.toString('utf8')));
                res.on('end', () => {
                    try {
                        resolve(classify(res.statusCode || 0, body));
                    } catch (e) {
                        reject(e);
                    }
                });
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

function request(url: string, sessionCookie: string): Promise<RawResponse> {
    const net = getElectronNet();
    return net ? requestViaElectron(net, url, sessionCookie) : requestViaHttps(url, sessionCookie);
}

// Which network transport is in use — 'electron' (desktop) passes Cloudflare; 'https'
// (remote/headless host) gets a 403 challenge or, on some networks, a failed connection.
export function getTransport(): 'electron' | 'https' {
    return getElectronNet() ? 'electron' : 'https';
}

// claude.ai /api/organizations/{orgId}/usage response (confirmed 2026-04-21):
//   { five_hour: {utilization, resets_at}, seven_day: {...},
//     seven_day_sonnet: {...}, seven_day_opus: null|{...} }
function normalizeUsage(json: any): NormalizedUsage {
    const read = (bucket: any) => ({
        percent: bucket && typeof bucket.utilization === 'number' ? bucket.utilization : null,
        resetAt: (bucket && bucket.resets_at) || null
    });

    const session = read(json?.five_hour);
    const weekly = read(json?.seven_day);
    const sonnet = read(json?.seven_day_sonnet);
    const opus = read(json?.seven_day_opus);

    return {
        sessionPercent: session.percent,
        sessionResetAt: session.resetAt,
        weeklyPercent: weekly.percent,
        weeklyResetAt: weekly.resetAt,
        sonnetPercent: sonnet.percent,
        sonnetResetAt: sonnet.resetAt,
        opusPercent: opus.percent,
        opusResetAt: opus.resetAt
    };
}

// Tries several candidate endpoints (the usage endpoint is unofficial). Returns the
// first that yields JSON. Throws AuthExpiredError on 401/403 so the caller can prompt
// for a fresh Session Key.
export async function fetchUsage(sessionCookie: string, orgId: string): Promise<UsageResult> {
    const candidates = [
        `${BASE}/api/organizations/${orgId}/usage`,
        `${BASE}/api/organizations/${orgId}/usage_limits`,
        `${BASE}/api/bootstrap/${orgId}/statsig`,
        `${BASE}/api/organizations/${orgId}`
    ];

    const errors: string[] = [];
    for (const url of candidates) {
        try {
            const res = await request(url, sessionCookie);
            if (res.json) {
                return { source: url, normalized: normalizeUsage(res.json) };
            }
        } catch (err: any) {
            if (err instanceof AuthExpiredError || err instanceof CloudflareBlockedError) throw err;
            errors.push(`${url} → ${err?.message ?? err}`);
        }
    }
    throw new Error(`All endpoints failed:\n${errors.join('\n')}`);
}
