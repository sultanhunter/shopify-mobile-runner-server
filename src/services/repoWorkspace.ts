import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECTS_ROOT = "/var/shopify-mobile/projects";
const BINARY_BASE64_PREFIX = "__binary_base64__:";
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".expo", ".next", "dist", "build", ".turbo"]);

function sanitizeProjectId(value: string): string {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
    return cleaned.length > 0 ? cleaned.slice(0, 120) : "project";
}

function repoPathForProject(projectId: string): string {
    return path.join(PROJECTS_ROOT, sanitizeProjectId(projectId), "repo");
}

function isBinaryBuffer(buffer: Buffer): boolean {
    const sampleSize = Math.min(buffer.length, 4096);
    for (let index = 0; index < sampleSize; index += 1) {
        if (buffer[index] === 0) {
            return true;
        }
    }

    return false;
}

function sanitizeRelativePath(filePath: string): string {
    const normalized = path.posix.normalize(filePath).replace(/^\/+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("\0")) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    return normalized;
}

async function ensureRepoExists(repoPath: string): Promise<void> {
    try {
        const repoStats = await stat(path.join(repoPath, ".git"));
        if (!repoStats.isDirectory()) {
            throw new Error("Repository .git path is not a directory.");
        }
    } catch {
        throw new Error(`Repository is not initialized at ${repoPath}`);
    }
}

async function collectFiles(rootPath: string, currentPath: string, output: string[]) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name.startsWith(".")) {
            if (!entry.isDirectory() || !EXCLUDED_DIRECTORIES.has(entry.name)) {
                // allow hidden files, skip hidden folders unless explicitly allowed below
            }
        }

        if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
            continue;
        }

        const absolutePath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
            await collectFiles(rootPath, absolutePath, output);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
        if (!relativePath || relativePath.startsWith("../")) {
            continue;
        }

        output.push(relativePath);
    }
}

export async function listProjectRepoFiles(projectId: string): Promise<string[]> {
    const repoPath = repoPathForProject(projectId);
    await ensureRepoExists(repoPath);

    const files: string[] = [];
    await collectFiles(repoPath, repoPath, files);
    return files.sort((a, b) => a.localeCompare(b));
}

export async function readProjectRepoFile(projectId: string, filePath: string): Promise<{
    path: string;
    isBinary: boolean;
    content: string;
}> {
    const repoPath = repoPathForProject(projectId);
    await ensureRepoExists(repoPath);

    const normalized = sanitizeRelativePath(filePath);
    const absolutePath = path.join(repoPath, normalized);
    if (!absolutePath.startsWith(repoPath)) {
        throw new Error("Refusing to read outside repository.");
    }

    const buffer = await readFile(absolutePath);
    const binary = isBinaryBuffer(buffer);

    return {
        path: normalized,
        isBinary: binary,
        content: binary ? "" : buffer.toString("utf8"),
    };
}

export async function applyFilesToProjectRepo(projectId: string, files: Record<string, string>): Promise<{
    written: string[];
    fileIndex: string[];
}> {
    const repoPath = repoPathForProject(projectId);
    await ensureRepoExists(repoPath);

    const written: string[] = [];

    for (const [filePath, content] of Object.entries(files)) {
        const normalized = sanitizeRelativePath(filePath);
        const absolutePath = path.join(repoPath, normalized);
        if (!absolutePath.startsWith(repoPath)) {
            throw new Error(`Refusing to write outside repository: ${filePath}`);
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        if (content.startsWith(BINARY_BASE64_PREFIX)) {
            await writeFile(absolutePath, Buffer.from(content.slice(BINARY_BASE64_PREFIX.length), "base64"));
        } else {
            await writeFile(absolutePath, content, "utf8");
        }

        written.push(normalized);
    }

    const fileIndex = await listProjectRepoFiles(projectId);
    return {
        written,
        fileIndex,
    };
}
