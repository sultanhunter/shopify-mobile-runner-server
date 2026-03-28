import { Request, Response, Router } from "express";
import { getDevSessionBackendProxyTarget } from "../services/devSession.js";

const router = Router();

function buildSuffixPath(originalUrl: string, marker: string): string {
    const markerIndex = originalUrl.indexOf(marker);
    if (markerIndex === -1) {
        return "/";
    }

    const suffix = originalUrl.slice(markerIndex + marker.length);
    if (!suffix.length) {
        return "/";
    }

    return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

function copyUpstreamHeaders(upstream: globalThis.Response, res: Response) {
    const passthroughHeaders = [
        "content-type",
        "cache-control",
        "etag",
        "last-modified",
        "content-encoding",
        "content-length",
    ];

    for (const headerName of passthroughHeaders) {
        const value = upstream.headers.get(headerName);
        if (value) {
            res.setHeader(headerName, value);
        }
    }
}

function resolveForwardPath(req: Request): string {
    const marker = req.originalUrl.includes("/expo-backend")
        ? `/api/shopify-mobile/dev-session/${encodeURIComponent(req.params.sessionId)}/expo-backend`
        : `/api/shopify-mobile/dev-session/${encodeURIComponent(req.params.sessionId)}/backend`;
    return buildSuffixPath(req.originalUrl, marker);
}

function buildRequestBody(req: Request): string | Buffer | undefined {
    if (req.method === "GET" || req.method === "HEAD") {
        return undefined;
    }

    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
        return req.body;
    }

    if (req.body && typeof req.body === "object") {
        return JSON.stringify(req.body);
    }

    return undefined;
}

async function handleBackendProxy(req: Request, res: Response) {
    const sessionId = req.params.sessionId;
    const target = getDevSessionBackendProxyTarget(sessionId);
    if (!target) {
        return res.status(404).json({ error: "Session not found or expo backend target not ready." });
    }

    const forwardPath = resolveForwardPath(req);
    const relative = new URL(forwardPath, "http://proxy.local");
    const upstreamUrl = new URL(target);
    upstreamUrl.pathname = relative.pathname;
    upstreamUrl.search = relative.search;

    const headers: Record<string, string> = {
        Accept: req.headers.accept || "*/*",
    };

    const contentType = req.headers["content-type"];
    if (typeof contentType === "string") {
        headers["Content-Type"] = contentType;
    }

    const body = buildRequestBody(req);

    try {
        const upstream = await fetch(upstreamUrl.toString(), {
            method: req.method,
            headers,
            body,
        });

        res.status(upstream.status);
        copyUpstreamHeaders(upstream, res);

        if (req.method === "HEAD") {
            res.end();
            return;
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.send(buffer);
    } catch (error) {
        res.status(502).json({
            error: error instanceof Error ? error.message : "Failed to proxy expo backend request.",
        });
    }
}

router.all("/shopify-mobile/dev-session/:sessionId/expo-backend", handleBackendProxy);
router.all("/shopify-mobile/dev-session/:sessionId/expo-backend/*", handleBackendProxy);
router.all("/shopify-mobile/dev-session/:sessionId/backend", handleBackendProxy);
router.all("/shopify-mobile/dev-session/:sessionId/backend/*", handleBackendProxy);

export default router;
