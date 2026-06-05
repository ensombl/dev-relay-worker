const ROOM_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_ROOMS = new Set(["subscribe", "health", "ready", "metrics"]);

function normalizePath(path: string): string {
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    while (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
    }

    return path;
}

function normalizeSubscriptionPath(path: string): string {
    if (path.endsWith("/*") || path.endsWith("*")) {
        return path.startsWith("/") ? path : "/" + path;
    }

    return normalizePath(path);
}

function isValidRoom(room: string): boolean {
    return ROOM_PATTERN.test(room) && !RESERVED_ROOMS.has(room.toLowerCase());
}

function roomKey(room: string, path: string): string {
    return `${room}:${path}`;
}

function getRoomRequestPath(
    pathname: string
): { room: string; targetPath: string } | null {
    if (pathname === "/") return null;

    const [, room = "", ...targetSegments] = pathname.split("/");
    if (!isValidRoom(room)) return null;

    return {
        room,
        targetPath:
            targetSegments.length === 0
                ? "/"
                : normalizePath("/" + targetSegments.join("/")),
    };
}

async function findBestMatchingPattern(
    room: string,
    requestPath: string,
    env: Env
): Promise<string | null> {
    const normalizedRequestPath = normalizePath(requestPath);

    const candidatePatterns: string[] = [];

    candidatePatterns.push(normalizedRequestPath);
    // Generate wildcard patterns based on path segments
    const segments = normalizedRequestPath
        .split("/")
        .filter((s) => s.length > 0);

    for (let i = 1; i <= segments.length; i++) {
        const basePath = "/" + segments.slice(0, i).join("/");

        candidatePatterns.push(basePath + "*");

        if (segments.length > i) {
            candidatePatterns.push(basePath + "/*");
        }
    }

    for (let i = 1; i < segments.length; i++) {
        const parentPath = "/" + segments.slice(0, i).join("/");
        candidatePatterns.push(parentPath + "/*");
    }

    candidatePatterns.sort((a, b) => {
        const aPrefix = a.replace(/\*$/, "");
        const bPrefix = b.replace(/\*$/, "");
        return bPrefix.length - aPrefix.length;
    });

    for (const pattern of candidatePatterns) {
        const id = env.RELAY_ROOM.idFromName(roomKey(room, pattern));
        const stub = env.RELAY_ROOM.get(id);

        try {
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

const handler = {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);

        // Clients subscribe by room + pattern (exact or wildcard)
        // Examples:
        // - wss://relay.dev.ensombl.io/subscribe?room=acme&path=/webhook/sumsub
        // - wss://relay.dev.ensombl.io/subscribe?room=acme&path=/webhook/*
        if (url.pathname === "/subscribe") {
            const room = url.searchParams.get("room");
            const path = url.searchParams.get("path");
            if (!room || !isValidRoom(room))
                return new Response("bad room", { status: 400 });
            if (!path) return new Response("bad path", { status: 400 });

            const normalizedPath = normalizeSubscriptionPath(path);

            const id = env.RELAY_ROOM.idFromName(roomKey(room, normalizedPath));
            return env.RELAY_ROOM.get(id).fetch(request); // DO handles WS upgrade
        }

        const roomRequest = getRoomRequestPath(url.pathname);
        if (!roomRequest) return new Response("bad room", { status: 400 });

        const { room, targetPath } = roomRequest;
        const matchingPattern = await findBestMatchingPattern(
            room,
            targetPath,
            env
        );

        const targetUrl = new URL(request.url);
        targetUrl.pathname = targetPath;
        const targetRequest = new Request(targetUrl.toString(), request);

        if (!matchingPattern) {
            const id = env.RELAY_ROOM.idFromName(roomKey(room, targetPath));
            return env.RELAY_ROOM.get(id).fetch(targetRequest);
        }

        const id = env.RELAY_ROOM.idFromName(roomKey(room, matchingPattern));
        return env.RELAY_ROOM.get(id).fetch(targetRequest);
    },
} satisfies ExportedHandler<Env>;

export default handler;

// Export Durable Object classes (required by Wrangler)
export { RelayRoom } from "./relayRoom";
