import {appConfig} from "./config.js";
import type {SavedAuthRecord} from "./openai.js";

function normalizeBaseUrl(value: string): string {
    return String(value ?? "").trim().replace(/\/+$/, "");
}

function getCLIProxyAPIConfig(): { baseUrl: string; managementKey: string } {
    const baseUrl = normalizeBaseUrl(appConfig.cliproxyApiBaseUrl);
    const managementKey = String(appConfig.cliproxyApiManagementKey ?? "").trim();
    if (!baseUrl) {
        throw new Error("cliproxyApiBaseUrl 未配置");
    }
    if (!managementKey) {
        throw new Error("cliproxyApiManagementKey 未配置");
    }
    return {
        baseUrl,
        managementKey,
    };
}

function createManagementHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const {managementKey} = getCLIProxyAPIConfig();
    return {
        Authorization: `Bearer ${managementKey}`,
        Accept: "application/json",
        ...extraHeaders,
    };
}

export interface CLIProxyAuthFileItem {
    name: string;
    type?: string;
    disabled?: boolean;
    [key: string]: unknown;
}

export function shouldAutoUploadAuthToCLIProxyAPI(): boolean {
    return appConfig.cliproxyApiAutoUploadAuth;
}

export async function listAuthFilesFromCLIProxyAPI(): Promise<CLIProxyAuthFileItem[]> {
    const {baseUrl} = getCLIProxyAPIConfig();
    const response = await fetch(`${baseUrl}/v0/management/auth-files`, {
        method: "GET",
        headers: createManagementHeaders(),
    });
    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 获取 auth 列表失败: ${response.status} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as { files?: Array<Record<string, unknown>> };
    return Array.isArray(payload?.files)
        ? payload.files
            .map((item) => ({
                ...item,
                name: String(item?.name ?? "").trim(),
                type: typeof item?.type === "string" ? item.type.trim() : undefined,
            }))
            .filter((item) => item.name)
        : [];
}

export async function downloadAuthFileJsonObjectFromCLIProxyAPI(name: string): Promise<Record<string, unknown>> {
    const {baseUrl} = getCLIProxyAPIConfig();
    const url = new URL(`${baseUrl}/v0/management/auth-files/download`);
    url.searchParams.set("name", name);
    const response = await fetch(url, {
        method: "GET",
        headers: createManagementHeaders(),
    });
    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 下载 auth 失败: ${response.status} name=${name} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(`CLIProxyAPI auth 内容不是合法 JSON 对象: ${name}`);
    }
    return payload;
}

export async function saveAuthFileJsonObjectToCLIProxyAPI(
    fileName: string,
    record: Record<string, unknown>,
): Promise<void> {
    const {baseUrl} = getCLIProxyAPIConfig();
    if (!fileName.toLowerCase().endsWith(".json")) {
        throw new Error(`上传到 CLIProxyAPI 的 auth 文件名必须是 .json: ${fileName}`);
    }

    const url = new URL(`${baseUrl}/v0/management/auth-files`);
    url.searchParams.set("name", fileName);

    const response = await fetch(url, {
        method: "POST",
        headers: createManagementHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify(record, null, 2),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 上传 auth 失败: ${response.status} body=${rawBody}`);
    }
}

export async function deleteAuthFileFromCLIProxyAPI(fileName: string): Promise<void> {
    const {baseUrl} = getCLIProxyAPIConfig();
    const response = await fetch(`${baseUrl}/v0/management/auth-files`, {
        method: "DELETE",
        headers: createManagementHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            names: [fileName],
        }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 删除 auth 失败: ${response.status} body=${rawBody}`);
    }
}

export async function setAuthFileDisabledStatusToCLIProxyAPI(
    fileName: string,
    disabled: boolean,
): Promise<void> {
    const {baseUrl} = getCLIProxyAPIConfig();
    const response = await fetch(`${baseUrl}/v0/management/auth-files/status`, {
        method: "PATCH",
        headers: createManagementHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            name: fileName,
            disabled,
        }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 更新 auth 状态失败: ${response.status} body=${rawBody}`);
    }
}

export async function uploadAuthFileToCLIProxyAPI(
    fileName: string,
    record: SavedAuthRecord,
): Promise<void> {
    if (!appConfig.cliproxyApiAutoUploadAuth) {
        return;
    }
    await saveAuthFileJsonObjectToCLIProxyAPI(fileName, record as unknown as Record<string, unknown>);
}
