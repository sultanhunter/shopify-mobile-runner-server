import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

export interface RuntimeDatabaseProvisionResult {
    provider: string;
    databaseName: string;
    roleName: string;
    databaseUrl: string;
}

function getRuntimeAdminDatabaseUrl(): string {
    const value =
        process.env.RUNNER_RUNTIME_ADMIN_DATABASE_URL?.trim() ||
        process.env.RUNTIME_ADMIN_DATABASE_URL?.trim() ||
        process.env.NEON_ADMIN_DATABASE_URL?.trim();

    if (!value) {
        throw new Error(
            "RUNNER_RUNTIME_ADMIN_DATABASE_URL is required for runtime DB provisioning on runner.",
        );
    }

    return value;
}

function getRuntimeDatabasePrefix(): string {
    return (
        process.env.RUNNER_RUNTIME_DATABASE_PREFIX?.trim() ||
        process.env.RUNTIME_DATABASE_PREFIX?.trim() ||
        process.env.NEON_RUNTIME_DATABASE_PREFIX?.trim() ||
        "shopify_runtime_"
    );
}

function getRuntimeRolePrefix(): string {
    return (
        process.env.RUNNER_RUNTIME_ROLE_PREFIX?.trim() ||
        process.env.RUNTIME_ROLE_PREFIX?.trim() ||
        process.env.NEON_RUNTIME_ROLE_PREFIX?.trim() ||
        "shopify_runtime_"
    );
}

function sanitizeIdentifier(input: string, fallbackPrefix: string): string {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/__+/g, "_");

    const base = normalized || fallbackPrefix;
    const prefixed = /^[a-z_]/.test(base) ? base : `${fallbackPrefix}_${base}`;
    return prefixed.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH);
}

function buildProjectName(prefix: string, projectId: string, fallbackPrefix: string): string {
    const compactProjectId = projectId
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase()
        .slice(0, 28);
    const raw = `${prefix}${compactProjectId}`;
    return sanitizeIdentifier(raw, fallbackPrefix);
}

function makeRuntimeDatabaseUrl(
    adminDatabaseUrl: string,
    params: { roleName: string; password: string; databaseName: string },
): string {
    const url = new URL(adminDatabaseUrl);
    url.username = params.roleName;
    url.password = params.password;
    url.pathname = `/${params.databaseName}`;

    if (!url.searchParams.has("sslmode")) {
        url.searchParams.set("sslmode", "require");
    }

    return url.toString();
}

function createAdminPool(connectionString: string): Pool {
    return new Pool({
        connectionString,
        max: 1,
        ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    });
}

export async function provisionRuntimeDatabase(projectId: string): Promise<RuntimeDatabaseProvisionResult> {
    const adminDatabaseUrl = getRuntimeAdminDatabaseUrl();
    const databaseName = buildProjectName(getRuntimeDatabasePrefix(), projectId, "runtime_db");
    const roleName = buildProjectName(getRuntimeRolePrefix(), projectId, "runtime_role");
    const rolePassword = randomBytes(24).toString("hex");

    const pool = createAdminPool(adminDatabaseUrl);

    try {
        const roleExists = await pool.query("select 1 from pg_roles where rolname = $1 limit 1", [roleName]);
        if (roleExists.rowCount && roleExists.rowCount > 0) {
            await pool.query(`alter role ${roleName} with login password '${rolePassword}'`);
        } else {
            await pool.query(`create role ${roleName} with login password '${rolePassword}'`);
        }

        const databaseExists = await pool.query("select 1 from pg_database where datname = $1 limit 1", [databaseName]);
        if (!databaseExists.rowCount || databaseExists.rowCount === 0) {
            await pool.query(`create database ${databaseName} owner ${roleName}`);
        }

        await pool.query(`grant all privileges on database ${databaseName} to ${roleName}`);
    } finally {
        await pool.end();
    }

    return {
        provider: "postgres",
        databaseName,
        roleName,
        databaseUrl: makeRuntimeDatabaseUrl(adminDatabaseUrl, {
            roleName,
            password: rolePassword,
            databaseName,
        }),
    };
}
