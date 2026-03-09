import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateExpoScaffold } from "./expoScaffold.js";
import { insertWorkspaceTask, updateWorkspaceTask, upsertProject } from "./supabase.js";

const execFileAsync = promisify(execFile);
const BINARY_BASE64_PREFIX = "__binary_base64__:";

interface CreateWorkspaceInput {
    name: string;
    sdk: string;
}

interface GithubState {
    enabled: boolean;
    owner?: string;
    repo?: string;
    repoUrl?: string;
    defaultBranch?: string;
    lastCommitSha?: string;
    lastCommitMessage?: string;
    lastSyncedAt?: string;
    error?: string;
}

function toSlug(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 42);

    return normalized || "shopify-mobile-app";
}

function buildPreview(projectName: string) {
    return {
        appName: projectName,
        theme: "light",
        primaryColor: "#0f766e",
        screens: [
            {
                id: "home",
                title: "Home",
                description: "Merchandising home screen with Shopify-powered sections.",
                blocks: ["Hero", "Featured products", "Collections"],
            },
            {
                id: "products",
                title: "Products",
                description: "Browse products from Shopify with filters and sorting.",
                blocks: ["Search", "Filters", "Product grid"],
            },
            {
                id: "cart",
                title: "Cart",
                description: "Review selected products and move to checkout.",
                blocks: ["Cart items", "Promo code", "Checkout CTA"],
            },
        ],
    };
}

function getGithubToken(): string | undefined {
    return process.env.GITHUB_TOKEN?.trim() || process.env.SHOPIFY_MOBILE_GITHUB_TOKEN?.trim() || undefined;
}

function githubHeaders(token: string): Record<string, string> {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shopify-mobile-runner-server",
        "Content-Type": "application/json",
    };
}

async function githubApi<T>(url: string, init: RequestInit, fallbackError: string): Promise<T> {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as
        | (T & { message?: string })
        | { message?: string }
        | null;

    if (!response.ok || !payload) {
        const message = payload && typeof payload === "object" && "message" in payload ? payload.message : undefined;
        throw new Error(message || fallbackError);
    }

    return payload as T;
}

async function getGithubOwner(token: string): Promise<string> {
    const configured = process.env.GITHUB_OWNER?.trim();
    if (configured) {
        return configured;
    }

    const me = await githubApi<{ login: string }>(
        "https://api.github.com/user",
        {
            method: "GET",
            headers: githubHeaders(token),
        },
        "Failed to fetch GitHub owner.",
    );

    return me.login;
}

async function createGithubRepo(params: {
    token: string;
    owner: string;
    projectName: string;
    projectId: string;
}): Promise<{ owner: string; repo: string; repoUrl: string; defaultBranch: string }> {
    const repo = `${toSlug(params.projectName)}-${params.projectId.slice(0, 8)}`;
    const body = {
        name: repo,
        private: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
    };

    const created = await (async () => {
        try {
            return await githubApi<{
                owner?: { login?: string };
                name?: string;
                clone_url?: string;
                default_branch?: string;
            }>(
            `https://api.github.com/orgs/${encodeURIComponent(params.owner)}/repos`,
            {
                method: "POST",
                headers: githubHeaders(params.token),
                body: JSON.stringify(body),
            },
            "Failed to create GitHub repository for organization.",
        );
        } catch {
            return await githubApi<{
                owner?: { login?: string };
                name?: string;
                clone_url?: string;
                default_branch?: string;
            }>(
            "https://api.github.com/user/repos",
            {
                method: "POST",
                headers: githubHeaders(params.token),
                body: JSON.stringify(body),
            },
            "Failed to create GitHub repository for user.",
        );
        }
    })();

    const owner = created.owner?.login || params.owner;
    const name = created.name || repo;
    const cloneUrl = created.clone_url;
    const defaultBranch = created.default_branch || "main";

    if (!cloneUrl) {
        throw new Error("GitHub repository response missing clone URL.");
    }

    return {
        owner,
        repo: name,
        repoUrl: cloneUrl,
        defaultBranch,
    };
}

function withGithubToken(repoUrl: string, token: string): string {
    const parsed = new URL(repoUrl);
    parsed.username = "x-access-token";
    parsed.password = token;
    return parsed.toString();
}

async function writeScaffoldFiles(rootDir: string, files: Record<string, string>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
        const safeRelativePath = path.posix.normalize(relativePath).replace(/^\/+/, "");
        if (!safeRelativePath || safeRelativePath.startsWith("../")) {
            continue;
        }

        const destination = path.join(rootDir, safeRelativePath);
        if (!destination.startsWith(rootDir)) {
            continue;
        }

        await mkdir(path.dirname(destination), { recursive: true });

        if (content.startsWith(BINARY_BASE64_PREFIX)) {
            const encoded = content.slice(BINARY_BASE64_PREFIX.length);
            await writeFile(destination, Buffer.from(encoded, "base64"));
        } else {
            await writeFile(destination, content, "utf8");
        }
    }
}

async function runGit(command: string, args: string[], cwd: string): Promise<string> {
    const result = await execFileAsync(command, args, {
        cwd,
        timeout: 300000,
        maxBuffer: 30 * 1024 * 1024,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: process.env.SHOPIFY_MOBILE_GIT_AUTHOR_NAME || "Shopify Mobile AI",
            GIT_AUTHOR_EMAIL: process.env.SHOPIFY_MOBILE_GIT_AUTHOR_EMAIL || "shopify-mobile-ai@local.dev",
            GIT_COMMITTER_NAME: process.env.SHOPIFY_MOBILE_GIT_COMMITTER_NAME || "Shopify Mobile AI",
            GIT_COMMITTER_EMAIL: process.env.SHOPIFY_MOBILE_GIT_COMMITTER_EMAIL || "shopify-mobile-ai@local.dev",
        },
    });

    return result.stdout.trim();
}

async function seedGithubRepository(params: {
    files: Record<string, string>;
    repoUrl: string;
    token: string;
    branch: string;
}): Promise<string> {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "shopify-mobile-seed-"));

    try {
        await writeScaffoldFiles(tmp, params.files);

        await runGit("git", ["init"], tmp);
        await runGit("git", ["checkout", "-b", params.branch], tmp);
        await runGit("git", ["add", "."], tmp);
        await runGit("git", ["commit", "-m", "chore(ai): initialize Expo app scaffold"], tmp);
        await runGit("git", ["remote", "add", "origin", withGithubToken(params.repoUrl, params.token)], tmp);
        await runGit("git", ["push", "-u", "origin", params.branch], tmp);
        const commitSha = await runGit("git", ["rev-parse", "HEAD"], tmp);

        return commitSha;
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

function initialGithubState(): GithubState {
    return {
        enabled: false,
        error: "GitHub sync not attempted yet.",
    };
}

async function runCreateWorkspaceTask(taskId: string, input: CreateWorkspaceInput): Promise<void> {
    await updateWorkspaceTask(taskId, { status: "running", error: null });

    const now = new Date().toISOString();
    const projectId = randomUUID();
    const preview = buildPreview(input.name);

    const scaffold = await generateExpoScaffold(input.name, input.sdk);

    const messages = [
        {
            id: randomUUID(),
            role: "system",
            content: "Project initialized. This workspace will generate and update an Expo mobile app connected to your Shopify store via backend APIs.",
            createdAt: now,
        },
        {
            id: randomUUID(),
            role: "assistant",
            content: "Ready. Prompt me with mobile app requirements for your Shopify store.",
            createdAt: now,
        },
    ];

    if (scaffold.warnings.length > 0) {
        messages.push({
            id: randomUUID(),
            role: "assistant",
            content: `Expo scaffold warnings: ${scaffold.warnings.join(" | ")}`,
            createdAt: now,
        });
    }

    const github: GithubState = initialGithubState();
    const githubToken = getGithubToken();

    if (githubToken) {
        try {
            const owner = await getGithubOwner(githubToken);
            const repo = await createGithubRepo({
                token: githubToken,
                owner,
                projectName: input.name,
                projectId,
            });

            const commitSha = await seedGithubRepository({
                files: scaffold.files,
                repoUrl: repo.repoUrl,
                token: githubToken,
                branch: repo.defaultBranch,
            });

            github.enabled = true;
            github.owner = repo.owner;
            github.repo = repo.repo;
            github.repoUrl = repo.repoUrl;
            github.defaultBranch = repo.defaultBranch;
            github.lastCommitSha = commitSha;
            github.lastCommitMessage = "chore(ai): initialize Expo app scaffold";
            github.lastSyncedAt = new Date().toISOString();
            github.error = undefined;
        } catch (error) {
            github.enabled = false;
            github.error = error instanceof Error ? error.message : "Failed to create GitHub repository.";
        }
    } else {
        github.error = "Set GITHUB_TOKEN to enable automatic repository creation and commits.";
    }

    const project = {
        id: projectId,
        name: input.name,
        createdAt: now,
        updatedAt: now,
        expoSdk: scaffold.sdk,
        preview,
        files: scaffold.files,
        messages,
        runs: [],
        github,
    };

    await upsertProject(project);
    await updateWorkspaceTask(taskId, {
        status: "completed",
        project_id: projectId,
        result: {
            projectId,
            expoSdk: scaffold.sdk,
        },
        error: null,
    });
}

export async function enqueueCreateWorkspaceTask(input: CreateWorkspaceInput): Promise<{
    id: string;
    status: "queued";
}> {
    const task = await insertWorkspaceTask({
        type: "workspace.create",
        payload: {
            name: input.name,
            sdk: input.sdk,
        },
    });

    void runCreateWorkspaceTask(task.id, input).catch(async (error) => {
        await updateWorkspaceTask(task.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "Workspace task failed.",
        }).catch(() => null);
    });

    return {
        id: task.id,
        status: "queued",
    };
}
