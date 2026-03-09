import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDefaultExpoSdk, resolveExpoSupportVersion } from "./expoSupportMatrix.js";

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".expo", ".next", "dist", "build", ".turbo"]);
const BINARY_BASE64_PREFIX = "__binary_base64__:";
const BINARY_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".mp3",
    ".mp4",
    ".mov",
    ".zip",
    ".gz",
    ".pdf",
]);

function toSlug(projectName: string): string {
    const normalized = projectName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);

    return normalized || "shopify-mobile-app";
}

async function readScaffoldFilesRecursively(
    rootDir: string,
    currentDir: string,
    output: Record<string, string>,
    warnings: string[],
): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name.startsWith(".DS_Store")) {
            continue;
        }

        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

        if (entry.isDirectory()) {
            if (EXCLUDED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            await readScaffoldFilesRecursively(rootDir, absolutePath, output, warnings);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(extension)) {
            const content = await readFile(absolutePath);
            output[relativePath] = `${BINARY_BASE64_PREFIX}${content.toString("base64")}`;
            continue;
        }

        try {
            const content = await readFile(absolutePath, "utf8");
            output[relativePath] = content;
        } catch {
            try {
                const content = await readFile(absolutePath);
                output[relativePath] = `${BINARY_BASE64_PREFIX}${content.toString("base64")}`;
                warnings.push(`Stored non-text file as base64: ${relativePath}`);
            } catch {
                warnings.push(`Skipped unreadable file: ${relativePath}`);
            }
        }
    }
}

function getScaffoldTimeoutMs(): number {
    const timeoutMs = Number(process.env.EXPO_SCAFFOLD_TIMEOUT_MS ?? "300000");
    return Number.isFinite(timeoutMs) ? timeoutMs : 300000;
}

async function runCreateExpoApp(targetDir: string, sdk: string): Promise<{ sdk: string; warnings: string[] }> {
    const support = resolveExpoSupportVersion(sdk);
    const timeoutMs = getScaffoldTimeoutMs();

    await execFileAsync(
        "npx",
        [
            `create-expo-app@${support.createExpoAppVersion}`,
            targetDir,
            "--template",
            support.templateSpecifier,
            "--yes",
            "--no-install",
        ],
        {
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        },
    );

    return {
        sdk: support.sdk,
        warnings: [`Scaffolded with Expo sdk-${support.sdk} (${support.status}).`],
    };
}

export async function scaffoldExpoProjectToDirectory(params: {
    projectName: string;
    sdk?: string;
    targetDir: string;
}): Promise<{ sdk: string; warnings: string[] }> {
    const sdk = params.sdk ?? getDefaultExpoSdk();

    await mkdir(path.dirname(params.targetDir), { recursive: true });

    try {
        await stat(params.targetDir);
        await rm(params.targetDir, { recursive: true, force: true });
    } catch {
        // Target does not exist yet.
    }

    return runCreateExpoApp(params.targetDir, sdk);
}

export async function collectExpoProjectFiles(targetDir: string): Promise<{
    files: Record<string, string>;
    warnings: string[];
}> {
    const warnings: string[] = [];
    const files: Record<string, string> = {};
    await readScaffoldFilesRecursively(targetDir, targetDir, files, warnings);

    if (Object.keys(files).length === 0) {
        throw new Error("Scaffold generated zero files.");
    }

    return { files, warnings };
}

export async function generateExpoScaffold(projectName: string, sdk = getDefaultExpoSdk()): Promise<{
    sdk: string;
    files: Record<string, string>;
    warnings: string[];
}> {
    const tmpParent = await mkdtemp(path.join(os.tmpdir(), "shopify-mobile-expo-"));
    const slug = toSlug(projectName);
    const targetDir = path.join(tmpParent, slug);

    try {
        const scaffoldResult = await runCreateExpoApp(targetDir, sdk);
        const collected = await collectExpoProjectFiles(targetDir);

        return {
            sdk: scaffoldResult.sdk,
            files: collected.files,
            warnings: [
                ...collected.warnings,
                ...scaffoldResult.warnings,
            ],
        };
    } finally {
        await rm(tmpParent, { recursive: true, force: true });
    }
}
