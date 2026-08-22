export interface ApiKeyStorage {
    get(defaults: any, callback: (items: any) => void): void;
    set(items: any, callback?: () => void): void;
    remove(key: string, callback?: () => void): void;
}

export interface ApiKeyVerification {
    ok: boolean;
    username?: string;
    error?: string;
}

// API keys are user-pasted credentials. Validate them only with the documented
// third-party-safe profile endpoint and persist only after that succeeds.
export async function verifyAndSaveApiKey(
    rawApiKey: string,
    storage: ApiKeyStorage,
    fetchFn: typeof fetch = fetch
): Promise<ApiKeyVerification> {
    const apiKey = rawApiKey.trim();
    if (!apiKey) {
        return { ok: false, error: "Paste an API key before saving." };
    }
    try {
        const response = await fetchFn("https://nhentai.net/api/v2/user", {
            headers: { "Authorization": "Key " + apiKey },
            cache: "no-store"
        });
        if (!response.ok) {
            return { ok: false, error: "HTTP " + response.status };
        }
        const profile = await response.json();
        if (!profile || typeof profile.username !== "string" || !profile.username) {
            return { ok: false, error: "The API did not return a user profile" };
        }
        await new Promise<void>((resolve) => storage.set({ apiKey: apiKey }, resolve));
        return { ok: true, username: profile.username };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

export function removeApiKey(storage: ApiKeyStorage): Promise<void> {
    return new Promise((resolve) => storage.remove("apiKey", resolve));
}
