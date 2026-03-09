import { Request, Response, Router } from "express";
import { markProjectActivity } from "../services/activityTracker.js";
import { applyFilesToProjectRepo, listProjectRepoFiles, readProjectRepoFile } from "../services/repoWorkspace.js";

interface ApplyFilesBody {
    files?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bearerToken(headerValue: string | undefined): string | null {
    if (!headerValue) return null;
    const [scheme, token] = headerValue.split(" ");
    if (!scheme || !token) return null;
    if (scheme.toLowerCase() !== "bearer") return null;
    return token;
}

function authorizeRequest(req: Request, res: Response): boolean {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }

    return true;
}

const router = Router();

router.get("/shopify-mobile/repo/:projectId/files", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const projectId = asNonEmptyString(req.params.projectId);
    if (!projectId) {
        return res.status(400).json({ error: "projectId is required." });
    }

    try {
        markProjectActivity(projectId, "repo/files");
        const files = await listProjectRepoFiles(projectId);
        return res.json({ files });
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to list repository files.",
        });
    }
});

router.get("/shopify-mobile/repo/:projectId/file", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const projectId = asNonEmptyString(req.params.projectId);
    const filePath = asNonEmptyString(req.query.path);
    if (!projectId || !filePath) {
        return res.status(400).json({ error: "projectId and path are required." });
    }

    try {
        markProjectActivity(projectId, "repo/file");
        const file = await readProjectRepoFile(projectId, filePath);
        return res.json(file);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to read repository file.",
        });
    }
});

router.post("/shopify-mobile/repo/:projectId/apply-files", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const projectId = asNonEmptyString(req.params.projectId);
    if (!projectId) {
        return res.status(400).json({ error: "projectId is required." });
    }

    const body = req.body as ApplyFilesBody;
    const files = body.files as Record<string, string> | undefined;

    if (!files || typeof files !== "object" || Object.keys(files).length === 0) {
        return res.status(400).json({ error: "files map is required." });
    }

    try {
        markProjectActivity(projectId, "repo/apply-files");
        const result = await applyFilesToProjectRepo(projectId, files);
        return res.json(result);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to apply files to repository.",
        });
    }
});

export default router;
