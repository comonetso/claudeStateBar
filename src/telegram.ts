import * as https from 'https';

function apiCall(token: string, method: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body ?? {});
        const req = https.request(
            {
                hostname: 'api.telegram.org',
                path: `/bot${token}/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 10000
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        resolve(null);
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(data);
        req.end();
    });
}

export async function sendMessage(token: string, chatId: string, text: string): Promise<boolean> {
    if (!token || !chatId) return false;
    try {
        const r = await apiCall(token, 'sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
        });
        return r?.ok === true;
    } catch {
        return false;
    }
}

export interface LinkResult {
    chatId: string;
    name: string;
}

// Resolves the chat ID of whoever last messaged the bot. The user must send the bot a
// message first. Polls getUpdates a few times before giving up.
export async function resolveFirstChatId(token: string, maxAttempts = 3): Promise<LinkResult> {
    if (!token) throw new Error('token required');
    for (let i = 0; i < maxAttempts; i++) {
        const r = await apiCall(token, 'getUpdates', { limit: 10, timeout: 3 });
        if (!r?.ok) throw new Error(r?.description || 'getUpdates failed');
        const updates: any[] = r.result ?? [];
        if (updates.length > 0) {
            const last = updates[updates.length - 1];
            const chat = last?.message?.chat ?? last?.my_chat_member?.chat;
            if (chat?.id) {
                return {
                    chatId: String(chat.id),
                    name: chat.first_name ?? chat.title ?? String(chat.id)
                };
            }
        }
        if (i < maxAttempts - 1) {
            await new Promise((r) => setTimeout(r, 1500));
        }
    }
    throw new Error('no_messages');
}

export async function testToken(token: string): Promise<any | false> {
    if (!token) return false;
    try {
        const r = await apiCall(token, 'getMe', {});
        return r?.ok === true ? r.result : false;
    } catch {
        return false;
    }
}
