import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectExpoProjectFiles, scaffoldExpoProjectToDirectory } from "./expoScaffold.js";
import { insertWorkspaceTask, updateWorkspaceTask, upsertProject } from "./supabase.js";

const execFileAsync = promisify(execFile);
const PROJECTS_ROOT = "/var/shopify-mobile/projects";

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

async function runGit(args: string[], cwd: string): Promise<string> {
    const result = await execFileAsync("git", args, {
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

async function setupAndPushRepository(params: {
    repoPath: string;
    repoUrl: string;
    token: string;
    branch: string;
}): Promise<string> {
    await runGit(["init"], params.repoPath);
    await runGit(["checkout", "-B", params.branch], params.repoPath);
    await runGit(["add", "."], params.repoPath);

    const status = await runGit(["status", "--porcelain"], params.repoPath);
    if (!status.trim()) {
        await runGit(["remote", "remove", "origin"], params.repoPath).catch(() => null);
        await runGit(["remote", "add", "origin", withGithubToken(params.repoUrl, params.token)], params.repoPath);
        const head = await runGit(["rev-parse", "HEAD"], params.repoPath).catch(() => "");
        if (head) {
            return head;
        }
        throw new Error("No changes found to commit while initializing repository.");
    }

    await runGit(["commit", "-m", "chore(ai): initialize Expo app scaffold"], params.repoPath);
    await runGit(["remote", "remove", "origin"], params.repoPath).catch(() => null);
    await runGit(["remote", "add", "origin", withGithubToken(params.repoUrl, params.token)], params.repoPath);
    await runGit(["push", "-u", "origin", params.branch], params.repoPath);
    return runGit(["rev-parse", "HEAD"], params.repoPath);
}

function initialGithubState(): GithubState {
    return {
        enabled: false,
        error: "GitHub sync not attempted yet.",
    };
}

async function runCreateWorkspaceTask(taskId: string, input: CreateWorkspaceInput): Promise<void> {
    console.log(`[TASK ${taskId}] workspace.create queued name=${input.name} sdk=${input.sdk}`);
    await updateWorkspaceTask(taskId, { status: "running", error: null });
    console.log(`[TASK ${taskId}] status=running`);

    const now = new Date().toISOString();
    const projectId = randomUUID();
    const workspacePath = path.join(PROJECTS_ROOT, projectId);
    const repoPath = path.join(workspacePath, "repo");

    const initialProject = {
        id: projectId,
        name: input.name,
        createdAt: now,
        updatedAt: now,
        expoSdk: input.sdk,
        preview: buildPreview(input.name),
        files: {},
        messages: [
            {
                id: randomUUID(),
                role: "system",
                content: "Project initialized. Creating Expo starter workspace...",
                createdAt: now,
            },
        ],
        runs: [],
        github: initialGithubState(),
    };

    await upsertProject(initialProject);
    await updateWorkspaceTask(taskId, { project_id: projectId });
    console.log(`[TASK ${taskId}] project row inserted id=${projectId}`);

    await mkdir(workspacePath, { recursive: true });
    const scaffold = await scaffoldExpoProjectToDirectory({
        projectName: input.name,
        sdk: input.sdk,
        targetDir: repoPath,
    });
    const collected = await collectExpoProjectFiles(repoPath);
    console.log(`[TASK ${taskId}] scaffold generated sdk=${scaffold.sdk} files=${Object.keys(collected.files).length}`);

    const updatedAtAfterScaffold = new Date().toISOString();
    const projectAfterScaffold = {
        ...initialProject,
        updatedAt: updatedAtAfterScaffold,
        expoSdk: scaffold.sdk,
        files: collected.files,
        messages: [
            {
                id: randomUUID(),
                role: "system",
                content: "Project initialized. This workspace now contains a clean Expo starter project.",
                createdAt: updatedAtAfterScaffold,
            },
            {
                id: randomUUID(),
                role: "assistant",
                content: "Ready. Connect your Shopify store to apply baseline commerce features.",
                createdAt: updatedAtAfterScaffold,
            },
            ...(scaffold.warnings.length > 0 || collected.warnings.length > 0
                ? [
                      {
                          id: randomUUID(),
                          role: "assistant",
                          content: `Expo scaffold warnings: ${[...scaffold.warnings, ...collected.warnings].join(" | ")}`,
                          createdAt: updatedAtAfterScaffold,
                      },
                  ]
                : []),
        ],
    };

    await upsertProject(projectAfterScaffold);

    const github: GithubState = { ...projectAfterScaffold.github };
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

            const commitSha = await setupAndPushRepository({
                repoPath,
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
            console.log(`[TASK ${taskId}] github initialized repo=${repo.owner}/${repo.repo}`);
        } catch (error) {
            github.enabled = false;
            github.error = error instanceof Error ? error.message : "Failed to create GitHub repository.";
            console.warn(`[TASK ${taskId}] github init failed: ${github.error}`);
        }
    } else {
        github.error = "Set GITHUB_TOKEN to enable automatic repository creation and commits.";
        console.log(`[TASK ${taskId}] github skipped (token missing)`);
    }

    const finalizedProject = {
        ...projectAfterScaffold,
        updatedAt: new Date().toISOString(),
        github,
    };

    await upsertProject(finalizedProject);
    await updateWorkspaceTask(taskId, {
        status: "completed",
        result: {
            projectId,
            expoSdk: scaffold.sdk,
        },
        error: null,
    });
    console.log(`[TASK ${taskId}] status=completed projectId=${projectId}`);
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
        const message = error instanceof Error ? error.message : "Workspace task failed.";
        console.error(`[TASK ${task.id}] status=failed error=${message}`);
        await updateWorkspaceTask(task.id, {
            status: "failed",
            error: message,
        }).catch(() => null);
    });

    return {
        id: task.id,
        status: "queued",
    };
}
