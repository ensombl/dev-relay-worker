/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const WS_CHUNK = 240 * 1024; // send body frames <= 240KiB (base64 keeps us far under 1MiB per WS message)

// ---------- Path normalization ----------
function normalizePath(path: string): string {
    // Add leading slash if missing
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    // Remove trailing slash except for root path "/"
    while (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
    }

    return path;
}

// ---------- Wildcard path matching ----------
async function findBestMatchingPattern(
    requestPath: string,
    env: Env
): Promise<string | null> {
    // Normalize the request path
    const normalizedRequestPath = normalizePath(requestPath);

    // Generate candidate patterns that could match this request path
    const candidatePatterns: string[] = [];

    // Add exact match (both normalized and original)
    candidatePatterns.push(normalizedRequestPath);
    if (normalizedRequestPath !== requestPath) {
        candidatePatterns.push(requestPath);
    }

    // Generate wildcard patterns based on path segments
    const segments = normalizedRequestPath
        .split("/")
        .filter((s) => s.length > 0);

    for (let i = 1; i <= segments.length; i++) {
        const basePath = "/" + segments.slice(0, i).join("/");

        // basePath + '*' matches basePath and anything under it
        candidatePatterns.push(basePath + "*");

        // basePath + '/*' only matches things under basePath (not basePath itself)
        // Only add this if we have more segments than the base path
        if (segments.length > i) {
            candidatePatterns.push(basePath + "/*");
        }
    }

    // For /webhooks/test, also check parent patterns like /webhooks/*
    for (let i = 1; i < segments.length; i++) {
        const parentPath = "/" + segments.slice(0, i).join("/");
        candidatePatterns.push(parentPath + "/*");
    }

    // Sort by specificity (longer prefixes first)
    candidatePatterns.sort((a, b) => {
        const aPrefix = a.replace(/\*$/, "");
        const bPrefix = b.replace(/\*$/, "");
        return bPrefix.length - aPrefix.length;
    });

    // Check each candidate pattern to see if it has active subscribers
    for (const pattern of candidatePatterns) {
        const id = env.RELAY_ROOM.idFromName(pattern);
        const stub = env.RELAY_ROOM.get(id);

        try {
            // Check if this pattern has active connections
            const response = await stub.fetch(
                new Request("http://internal/check-connections")
            );
            if (response.ok) {
                const hasConnections = await response.json();
                if (hasConnections) {
                    return pattern;
                }
            }
        } catch {
            // Continue if check fails
        }
    }

    return null;
}

// ---------- Worker entry ----------
const handler = {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);

        // Clients subscribe by pattern (exact or wildcard)
        // Examples:
        // - wss://relay.dev.ensombl.io/subscribe?path=/webhook/sumsub (exact)
        // - wss://relay.dev.ensombl.io/subscribe?path=/webhook/* (matches /webhook/anything)
        // - wss://relay.dev.ensombl.io/subscribe?path=/webhook* (matches /webhook and /webhook/anything)
        if (url.pathname === "/subscribe") {
            const path = url.searchParams.get("path");
            if (!path) return new Response("bad path", { status: 400 });

            // Normalize subscription path (handles leading/trailing slashes, but preserves wildcards)
            const normalizedPath =
                path.endsWith("/*") || path.endsWith("*")
                    ? path.startsWith("/")
                        ? path
                        : "/" + path // Just add leading slash for wildcards
                    : normalizePath(path); // Full normalization for regular paths

            // Use the normalized subscription path as the DO key
            const id = env.RELAY_ROOM.idFromName(normalizedPath);
            return env.RELAY_ROOM.get(id).fetch(request); // DO handles WS upgrade
        }

        // All other requests: find best matching pattern and route to its DO
        const requestPath = url.pathname;
        const matchingPattern = await findBestMatchingPattern(requestPath, env);

        if (!matchingPattern) {
            // No pattern matches - try exact path for backward compatibility
            const id = env.RELAY_ROOM.idFromName(requestPath);
            return env.RELAY_ROOM.get(id).fetch(request);
        }

        // Route to the matching pattern's DO
        const id = env.RELAY_ROOM.idFromName(matchingPattern);
        return env.RELAY_ROOM.get(id).fetch(request);
    },
} satisfies ExportedHandler<Env>;

export default handler;

// Export Durable Object classes (required by Wrangler)
export { RelayRoom } from "./relayRoom";
