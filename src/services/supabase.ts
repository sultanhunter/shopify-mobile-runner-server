import { randomUUID } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type RunnerTaskStatus = "queued" | "running" | "completed" | "failed";

interface TaskRow {
    id: string;
    type: string;
    status: RunnerTaskStatus;
    project_id: string | null;
    payload: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error: string | null;
    created_at: string;
    updated_at: string;
}

let cachedClient: SupabaseClient | null = null;

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required.`);
    }

    return value;
}

function getProjectsTableName(): string {
    return process.env.SUPABASE_PROJECTS_TABLE?.trim() || "projects";
}

function getTasksTableName(): string {
    return process.env.SUPABASE_TASKS_TABLE?.trim() || "tasks";
}

function getClient(): SupabaseClient {
    if (cachedClient) {
        return cachedClient;
    }

    cachedClient = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });

    return cachedClient;
}

export async function insertWorkspaceTask(params: {
    type: string;
    payload?: Record<string, unknown>;
}): Promise<TaskRow> {
    const now = new Date().toISOString();
    const row: TaskRow = {
        id: randomUUID(),
        type: params.type,
        status: "queued",
        project_id: null,
        payload: params.payload ?? null,
        result: null,
        error: null,
        created_at: now,
        updated_at: now,
    };

    const { error } = await getClient().from(getTasksTableName()).insert(row);
    if (error) {
        throw new Error(`Failed to create task: ${error.message}`);
    }

    return row;
}

export async function updateWorkspaceTask(
    taskId: string,
    patch: Partial<Pick<TaskRow, "status" | "project_id" | "result" | "error">>,
): Promise<void> {
    const { error } = await getClient()
        .from(getTasksTableName())
        .update({
            ...patch,
            updated_at: new Date().toISOString(),
        })
        .eq("id", taskId);

    if (error) {
        throw new Error(`Failed to update task ${taskId}: ${error.message}`);
    }
}

export async function upsertProject(project: Record<string, unknown>): Promise<void> {
    const id = String(project.id ?? "");
    const createdAt = String(project.createdAt ?? new Date().toISOString());
    const updatedAt = String(project.updatedAt ?? new Date().toISOString());

    if (!id) {
        throw new Error("Project id is required for upsert.");
    }

    const { error } = await getClient().from(getProjectsTableName()).upsert(
        {
            id,
            project,
            created_at: createdAt,
            updated_at: updatedAt,
        },
        { onConflict: "id" },
    );

    if (error) {
        throw new Error(`Failed to save project: ${error.message}`);
    }
}
