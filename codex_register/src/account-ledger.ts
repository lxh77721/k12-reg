import {randomUUID} from "node:crypto";
import {appendFile, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";

export type AccountLifecycleStatus =
    | "imported"
    | "free"
    | "registered"
    | "at_ready"
    | "plus_pending"
    | "plus_success"
    | "plus_failed"
    | "email_bound"
    | "oa_pending"
    | "oa_success"
    | "oa_failed"
    | "failed";

export type TaskStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type OaTarget = "sub2api" | "cpa";

export interface AccountRegisterSnapshot {
    taskId: string;
    batchId?: string;
    status: TaskStatus;
    phoneSignupSuccess?: boolean;
    missingAccessToken?: boolean;
    phoneProvider?: string;
    activationId?: string;
    smsCost?: number;
    smsCostCurrency?: string;
    tokenOut?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}

export interface AccountAccessTokenSnapshot {
    hash: string;
    preview?: string;
    tokenFile?: string;
    issuedAt?: string;
    active: boolean;
    email?: string;
    phone?: string;
    userId?: string;
    plan?: string;
    expiresAt?: string;
    expired?: boolean;
}

export interface AccountPlusSnapshot {
    localId: string;
    remoteJobId?: string;
    status: string;
    clientRef?: string;
    tokenHash?: string;
    tokenPhone?: string;
    tokenEmail?: string;
    paypalPhone?: string;
    resultCode?: string;
    billingStatus?: string;
    otpPending?: boolean;
    done?: boolean;
    removeTokenOnSuccess?: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface AccountEmailBindingSnapshot {
    email: string;
    status: "reserved" | "bound" | "failed" | "canceled";
    taskId?: string;
    target?: OaTarget;
    boundAt?: string;
    updatedAt: string;
}

export interface AccountOaSnapshot {
    taskId: string;
    target: OaTarget;
    status: TaskStatus;
    account?: string;
    sub2apiAccount?: string;
    cpaAccount?: string;
    sourceAccessTokenHash?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}

export interface AccountWorkflowSnapshot {
    runId?: string;
    step?: string;
    status?: string;
}

export interface AccountFreeSnapshot {
    workflowRunId?: string;
    completedAt: string;
    target: OaTarget;
    note?: string;
}

export interface AccountRecord {
    id: string;
    status: AccountLifecycleStatus;
    phone?: string;
    register?: AccountRegisterSnapshot;
    accessToken?: AccountAccessTokenSnapshot;
    plus?: AccountPlusSnapshot;
    emailBinding?: AccountEmailBindingSnapshot;
    oa?: AccountOaSnapshot;
    workflow?: AccountWorkflowSnapshot;
    free?: AccountFreeSnapshot;
    lastError?: string;
    lastErrorType?: string;
    createdAt: string;
    updatedAt: string;
}

export interface AccountEvent {
    id: string;
    type: string;
    accountId: string;
    createdAt: string;
    source?: string;
    sourceId?: string;
    payload?: Record<string, unknown>;
}

export interface LedgerTaskLike {
    id: string;
    kind: "register" | "oa-sub2api";
    status: TaskStatus;
    batchId?: string;
    accountId?: string;
    workflowRunId?: string;
    workflowStep?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    phone?: string;
    phoneProvider?: string;
    phoneActivationId?: string;
    smsCost?: number;
    smsCostCurrency?: string;
    tokenOut?: string;
    bindEmail?: string;
    oaTarget?: OaTarget;
    sub2apiAccount?: string;
    cpaAccount?: string;
    sourceAccessTokenHash?: string;
    accessTokenHash?: string;
    accessTokenPreview?: string;
    phoneSignupSuccess?: boolean;
    missingAccessToken?: boolean;
    error?: string;
    errorType?: string;
}

export interface LedgerPlusJobLike {
    localId: string;
    jobId?: string;
    status: string;
    clientRef?: string;
    accountId?: string;
    workflowRunId?: string;
    tokenHash?: string;
    tokenPreview?: string;
    tokenPhone?: string;
    tokenEmail?: string;
    paypalPhone?: string;
    resultCode?: string;
    billingStatus?: string;
    otpPending?: boolean;
    done?: boolean;
    removeTokenOnSuccess?: boolean;
    error?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
}

export interface LedgerTokenLike {
    hash: string;
    preview?: string;
    tokenFile?: string;
    email?: string;
    phone?: string;
    userId?: string;
    plan?: string;
    expiresAt?: string;
    expired?: boolean;
    issuedAt?: string;
    active?: boolean;
}

export interface AccountFindQuery {
    id?: string;
    phone?: string;
    tokenHash?: string;
    registerTaskId?: string;
    plusLocalId?: string;
    plusRemoteJobId?: string;
    oaTaskId?: string;
    email?: string;
    workflowRunId?: string;
}

export interface LedgerEmailStatusLike {
    email: string;
    status: "free" | "reserved" | "bound" | "failed" | "canceled" | "disabled";
    phone?: string;
    taskId?: string;
    target?: OaTarget;
    sub2apiAccount?: string;
    cpaAccount?: string;
    accessTokenHash?: string;
    error?: string;
    note?: string;
    updatedAt: string;
}

export interface AccountLedgerSummary {
    total: number;
    statuses: Record<string, number>;
    withPhone: number;
    withAccessToken: number;
    plusSuccess: number;
    oaSuccess: number;
}

function nowIso(): string {
    return new Date().toISOString();
}

function normalizePhone(phone?: string): string {
    const raw = String(phone ?? "").trim();
    if (!raw) return "";
    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) return raw;
    return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

function lower(value?: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function statusFromTask(task: LedgerTaskLike): AccountLifecycleStatus | undefined {
    if (task.kind === "register") {
        if (task.status === "success") return task.accessTokenHash ? "at_ready" : "registered";
        if (task.status === "failed" || task.status === "canceled") return "failed";
        return task.phone || task.accessTokenHash ? "registered" : undefined;
    }
    if (task.kind === "oa-sub2api") {
        if (task.status === "success") return "oa_success";
        if (task.status === "failed" || task.status === "canceled") return "oa_failed";
        return "oa_pending";
    }
    return undefined;
}

function deriveStatus(account: AccountRecord): AccountLifecycleStatus {
    const plusStatus = account.plus?.status.toLowerCase();
    const plusResultCode = account.plus?.resultCode?.toUpperCase();
    const plusSuccess = plusStatus === "success" || plusResultCode === "SUCCESS";
    if (account.free && !account.plus) return "free";
    if (account.oa?.status === "success") return "oa_success";
    if (account.oa && (account.oa.status === "queued" || account.oa.status === "running")) return "oa_pending";
    if (account.oa && (account.oa.status === "failed" || account.oa.status === "canceled")) return "oa_failed";
    if (account.emailBinding?.status === "bound") return "email_bound";
    if (account.plus) {
        const status = plusStatus ?? "";
        const resultCode = plusResultCode;
        if (plusSuccess) return "plus_success";
        if (account.plus.done || status === "failed" || resultCode === "FAILED") return "plus_failed";
        return "plus_pending";
    }
    if (account.accessToken?.hash) return "at_ready";
    if (account.register?.status === "success" || account.phone) return "registered";
    if (account.register?.status === "failed" || account.register?.status === "canceled") return "failed";
    return account.status || "imported";
}

function accountChanged(before: AccountRecord | undefined, after: AccountRecord): boolean {
    if (!before) return true;
    return JSON.stringify(before) !== JSON.stringify(after);
}

export class AccountLedger {
    private readonly accountsFile: string;
    private readonly eventsFile: string;
    private readonly accounts = new Map<string, AccountRecord>();
    private writeQueue: Promise<void> = Promise.resolve();
    private loaded = false;

    constructor(dataDir: string) {
        this.accountsFile = path.join(dataDir, "accounts.json");
        this.eventsFile = path.join(dataDir, "account-events.jsonl");
    }

    async load(): Promise<void> {
        await mkdir(path.dirname(this.accountsFile), {recursive: true});
        const raw = await readFile(this.accountsFile, "utf8").catch(() => "[]");
        let parsed: unknown = [];
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = [];
        }
        this.accounts.clear();
        const items = Array.isArray(parsed) ? parsed : [];
        for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const record = item as AccountRecord;
            if (!record.id) continue;
            record.status = deriveStatus(record);
            this.accounts.set(record.id, record);
        }
        this.loaded = true;
    }

    async ensureLoaded(): Promise<void> {
        if (!this.loaded) await this.load();
    }

    async list(): Promise<AccountRecord[]> {
        await this.ensureLoaded();
        return Array.from(this.accounts.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async summary(): Promise<AccountLedgerSummary> {
        const accounts = await this.list();
        const statuses: Record<string, number> = {};
        for (const account of accounts) {
            statuses[account.status] = (statuses[account.status] ?? 0) + 1;
        }
        return {
            total: accounts.length,
            statuses,
            withPhone: accounts.filter((account) => Boolean(account.phone)).length,
            withAccessToken: accounts.filter((account) => Boolean(account.accessToken?.hash)).length,
            plusSuccess: accounts.filter((account) => account.plus?.status.toLowerCase() === "success" || account.plus?.resultCode?.toUpperCase() === "SUCCESS").length,
            oaSuccess: accounts.filter((account) => account.oa?.status === "success").length,
        };
    }

    async get(id: string): Promise<AccountRecord | undefined> {
        await this.ensureLoaded();
        return this.accounts.get(id);
    }

    async find(query: AccountFindQuery): Promise<AccountRecord | undefined> {
        await this.ensureLoaded();
        return this.findLoaded(query);
    }

    async upsertFromTask(task: LedgerTaskLike, options: {eventType?: string; emitEvent?: boolean} = {}): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        const tokenHashValue = task.sourceAccessTokenHash || task.accessTokenHash || "";
        const phone = normalizePhone(task.phone);
        const email = task.kind === "oa-sub2api" ? task.bindEmail : "";
        const shouldCreate = Boolean(task.accountId || task.workflowRunId || phone || tokenHashValue || email || task.status === "success");
        if (!shouldCreate) return null;

        const account = this.findLoaded({
            id: task.accountId,
            registerTaskId: task.kind === "register" ? task.id : undefined,
            oaTaskId: task.kind === "oa-sub2api" ? task.id : undefined,
            tokenHash: tokenHashValue,
            phone,
            email,
            workflowRunId: task.workflowRunId,
        }) ?? this.createAccount();
        const before = structuredClone(account);
        if (phone) account.phone = phone;
        if (task.workflowRunId) {
            account.workflow = {
                ...account.workflow,
                runId: task.workflowRunId,
                step: task.workflowStep ?? account.workflow?.step,
            };
        }
        if (task.kind === "register") {
            account.register = {
                taskId: task.id,
                batchId: task.batchId,
                status: task.status,
                phoneSignupSuccess: task.phoneSignupSuccess,
                missingAccessToken: task.missingAccessToken,
                phoneProvider: task.phoneProvider,
                activationId: task.phoneActivationId,
                smsCost: task.smsCost,
                smsCostCurrency: task.smsCostCurrency,
                tokenOut: task.tokenOut,
                createdAt: task.createdAt,
                startedAt: task.startedAt,
                finishedAt: task.finishedAt,
            };
            if (task.accessTokenHash) {
                account.accessToken = {
                    ...account.accessToken,
                    hash: task.accessTokenHash,
                    preview: task.accessTokenPreview ?? account.accessToken?.preview,
                    tokenFile: task.tokenOut ?? account.accessToken?.tokenFile,
                    issuedAt: task.finishedAt ?? task.updatedAt,
                    active: true,
                    phone: phone || account.accessToken?.phone,
                };
            }
        } else {
            const bindStatus = task.status === "success"
                ? "bound"
                : task.status === "canceled"
                    ? "canceled"
                    : task.status === "failed"
                        ? "failed"
                        : "reserved";
            if (task.bindEmail) {
                account.emailBinding = {
                    email: task.bindEmail,
                    status: bindStatus,
                    taskId: task.id,
                    target: task.oaTarget ?? "sub2api",
                    boundAt: task.status === "success" ? task.finishedAt ?? task.updatedAt : account.emailBinding?.boundAt,
                    updatedAt: task.updatedAt,
                };
            }
            account.oa = {
                taskId: task.id,
                target: task.oaTarget ?? "sub2api",
                status: task.status,
                account: task.oaTarget === "cpa" ? task.cpaAccount : task.sub2apiAccount,
                sub2apiAccount: task.sub2apiAccount,
                cpaAccount: task.cpaAccount,
                sourceAccessTokenHash: tokenHashValue,
                createdAt: task.createdAt,
                startedAt: task.startedAt,
                finishedAt: task.finishedAt,
            };
            if (tokenHashValue) {
                account.accessToken = {
                    ...account.accessToken,
                    hash: tokenHashValue,
                    preview: task.accessTokenPreview ?? account.accessToken?.preview,
                    active: true,
                    phone: phone || account.accessToken?.phone,
                };
            }
        }
        if (task.status === "failed" || task.status === "canceled") {
            account.lastError = task.error;
            account.lastErrorType = task.errorType;
        }
        account.status = deriveStatus({...account, status: statusFromTask(task) ?? account.status});
        account.updatedAt = nowIso();
        this.accounts.set(account.id, account);
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? (task.kind === "register" ? "REGISTER_TASK_UPDATED" : "OA_TASK_UPDATED"),
                accountId: account.id,
                source: task.kind,
                sourceId: task.id,
                payload: compact({
                    status: task.status,
                    phone: account.phone,
                    tokenHash: tokenHashValue,
                    email,
                    target: task.oaTarget,
                    error: task.error,
                }),
            });
        }
        return account;
    }

    async upsertFromPlusJob(job: LedgerPlusJobLike, options: {eventType?: string; emitEvent?: boolean} = {}): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        const tokenHashValue = job.tokenHash ?? "";
        const phone = normalizePhone(job.tokenPhone);
        if (!job.accountId && !job.workflowRunId && !tokenHashValue && !phone && !job.localId) return null;
        const account = this.findLoaded({
            id: job.accountId,
            plusLocalId: job.localId,
            plusRemoteJobId: job.jobId,
            tokenHash: tokenHashValue,
            phone,
            workflowRunId: job.workflowRunId,
        }) ?? this.createAccount();
        const before = structuredClone(account);
        if (phone) account.phone = phone;
        if (job.workflowRunId) {
            account.workflow = {...account.workflow, runId: job.workflowRunId};
        }
        if (tokenHashValue) {
            account.accessToken = {
                ...account.accessToken,
                hash: tokenHashValue,
                preview: job.tokenPreview ?? account.accessToken?.preview,
                active: true,
                phone: phone || account.accessToken?.phone,
                email: job.tokenEmail ?? account.accessToken?.email,
            };
        }
        account.plus = {
            localId: job.localId,
            remoteJobId: job.jobId,
            status: job.status,
            clientRef: job.clientRef,
            tokenHash: tokenHashValue,
            tokenPhone: phone,
            tokenEmail: job.tokenEmail,
            paypalPhone: job.paypalPhone,
            resultCode: job.resultCode,
            billingStatus: job.billingStatus,
            otpPending: job.otpPending,
            done: job.done,
            removeTokenOnSuccess: job.removeTokenOnSuccess,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
        };
        if (job.error || job.errorMessage) {
            account.lastError = job.error || job.errorMessage;
        }
        account.status = deriveStatus(account);
        account.updatedAt = nowIso();
        this.accounts.set(account.id, account);
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? "PLUS_JOB_UPDATED",
                accountId: account.id,
                source: "plus",
                sourceId: job.localId,
                payload: compact({
                    status: job.status,
                    tokenHash: tokenHashValue,
                    phone,
                    paypalPhone: job.paypalPhone,
                    resultCode: job.resultCode,
                    otpPending: job.otpPending,
                    done: job.done,
                }),
            });
        }
        return account;
    }

    async upsertFromToken(token: LedgerTokenLike, options: {eventType?: string; emitEvent?: boolean} = {}): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        if (!token.hash) return null;
        const phone = normalizePhone(token.phone);
        const account = this.findLoaded({tokenHash: token.hash, phone}) ?? this.createAccount();
        const before = structuredClone(account);
        if (phone) account.phone = phone;
        account.accessToken = {
            ...account.accessToken,
            hash: token.hash,
            preview: token.preview ?? account.accessToken?.preview,
            tokenFile: token.tokenFile ?? account.accessToken?.tokenFile,
            issuedAt: token.issuedAt ?? account.accessToken?.issuedAt,
            active: token.active ?? true,
            email: token.email ?? account.accessToken?.email,
            phone: phone || account.accessToken?.phone,
            userId: token.userId ?? account.accessToken?.userId,
            plan: token.plan ?? account.accessToken?.plan,
            expiresAt: token.expiresAt ?? account.accessToken?.expiresAt,
            expired: token.expired ?? account.accessToken?.expired,
        };
        account.status = deriveStatus(account);
        account.updatedAt = nowIso();
        this.accounts.set(account.id, account);
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? "AT_IMPORTED",
                accountId: account.id,
                source: "token_pool",
                sourceId: token.hash,
                payload: compact({
                    tokenHash: token.hash,
                    phone,
                    email: token.email,
                    tokenFile: token.tokenFile,
                }),
            });
        }
        return account;
    }

    async upsertFromEmailStatus(status: LedgerEmailStatusLike, options: {eventType?: string; emitEvent?: boolean} = {}): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        const email = String(status.email ?? "").trim();
        const phone = normalizePhone(status.phone);
        const tokenHashValue = String(status.accessTokenHash ?? "").trim();
        const taskId = String(status.taskId ?? "").trim();
        if (!email) return null;
        if (!phone && !tokenHashValue && (!taskId || taskId.startsWith("wf_"))) return null;
        const account = this.findLoaded({
            phone,
            tokenHash: tokenHashValue,
            oaTaskId: taskId,
            email,
        }) ?? this.createAccount();
        const before = structuredClone(account);
        if (phone) account.phone = phone;
        if (tokenHashValue) {
            account.accessToken = {
                ...account.accessToken,
                hash: tokenHashValue,
                active: true,
                phone: phone || account.accessToken?.phone,
            };
        }

        const bindStatus = status.status === "disabled"
            ? "failed"
            : status.status === "free"
                ? "canceled"
                : status.status;
        account.emailBinding = {
            email,
            status: bindStatus,
            taskId,
            target: status.target ?? account.emailBinding?.target,
            boundAt: status.status === "bound" ? status.updatedAt : account.emailBinding?.boundAt,
            updatedAt: status.updatedAt,
        };
        if (status.status === "bound") {
            account.oa = {
                taskId: taskId || `manual:${email}`,
                target: status.target ?? "sub2api",
                status: "success",
                account: status.target === "cpa" ? status.cpaAccount : status.sub2apiAccount,
                sub2apiAccount: status.sub2apiAccount,
                cpaAccount: status.cpaAccount,
                sourceAccessTokenHash: tokenHashValue,
                createdAt: status.updatedAt,
                finishedAt: status.updatedAt,
            };
        }
        if (status.status === "failed" || status.status === "disabled") {
            account.lastError = status.error || status.note;
        }
        account.status = deriveStatus(account);
        account.updatedAt = nowIso();
        this.accounts.set(account.id, account);
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? "OA_EMAIL_STATUS_UPDATED",
                accountId: account.id,
                source: "oa_email_status",
                sourceId: email,
                payload: compact({
                    email,
                    phone,
                    status: status.status,
                    target: status.target,
                    tokenHash: tokenHashValue,
                    sub2apiAccount: status.sub2apiAccount,
                    cpaAccount: status.cpaAccount,
                }),
            });
        }
        return account;
    }

    async markTokenActive(hash: string, active: boolean, options: {eventType?: string; emitEvent?: boolean} = {}): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        const tokenHashValue = String(hash ?? "").trim();
        if (!tokenHashValue) return null;
        const account = this.findLoaded({tokenHash: tokenHashValue});
        if (!account?.accessToken) return null;
        const before = structuredClone(account);
        account.accessToken = {...account.accessToken, active};
        account.updatedAt = nowIso();
        account.status = deriveStatus(account);
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? (active ? "AT_MARKED_ACTIVE" : "AT_MARKED_INACTIVE"),
                accountId: account.id,
                source: "token_pool",
                sourceId: tokenHashValue,
                payload: {tokenHash: tokenHashValue, active},
            });
        }
        return account;
    }

    async markFree(
        query: AccountFindQuery,
        snapshot: {workflowRunId?: string; completedAt?: string; target?: OaTarget; note?: string} = {},
        options: {eventType?: string; emitEvent?: boolean} = {},
    ): Promise<AccountRecord | null> {
        await this.ensureLoaded();
        const account = this.findLoaded(query);
        if (!account) return null;
        const before = structuredClone(account);
        account.free = {
            workflowRunId: snapshot.workflowRunId,
            completedAt: snapshot.completedAt ?? nowIso(),
            target: snapshot.target ?? "sub2api",
            note: snapshot.note,
        };
        account.status = deriveStatus(account);
        account.updatedAt = nowIso();
        const changed = accountChanged(before, account);
        if (changed) await this.save();
        if (changed && options.emitEvent !== false) {
            await this.appendEvent({
                type: options.eventType ?? "ACCOUNT_MARKED_FREE",
                accountId: account.id,
                source: "account_ledger",
                sourceId: account.id,
                payload: compact({
                    workflowRunId: snapshot.workflowRunId,
                    target: snapshot.target ?? "sub2api",
                    completedAt: account.free.completedAt,
                    note: snapshot.note,
                }),
            });
        }
        return account;
    }

    async save(): Promise<void> {
        await this.ensureLoaded();
        const snapshot = Array.from(this.accounts.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
            await mkdir(path.dirname(this.accountsFile), {recursive: true});
            const tmp = `${this.accountsFile}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
            await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
            await rename(tmp, this.accountsFile);
        });
        await this.writeQueue;
    }

    async appendEvent(event: Omit<AccountEvent, "id" | "createdAt"> & {createdAt?: string}): Promise<void> {
        await mkdir(path.dirname(this.eventsFile), {recursive: true});
        const item: AccountEvent = {
            ...event,
            id: `evt_${Date.now()}_${randomUUID().slice(0, 8)}`,
            createdAt: event.createdAt ?? nowIso(),
        };
        await appendFile(this.eventsFile, `${JSON.stringify(item)}\n`, "utf8");
    }

    private createAccount(): AccountRecord {
        const createdAt = nowIso();
        return {
            id: `acc_${Date.now()}_${randomUUID().slice(0, 8)}`,
            status: "imported",
            createdAt,
            updatedAt: createdAt,
        };
    }

    private findLoaded(query: AccountFindQuery): AccountRecord | undefined {
        const id = String(query.id ?? "").trim();
        if (id && this.accounts.has(id)) return this.accounts.get(id);
        const phone = normalizePhone(query.phone);
        const tokenHashValue = String(query.tokenHash ?? "").trim();
        const email = lower(query.email);
        const workflowRunId = String(query.workflowRunId ?? "").trim();
        const accounts = Array.from(this.accounts.values());
        const find = (predicate: (account: AccountRecord) => boolean) => accounts.find(predicate);
        if (query.registerTaskId) {
            const account = find((item) => item.register?.taskId === query.registerTaskId);
            if (account) return account;
        }
        if (query.oaTaskId) {
            const account = find((item) => item.oa?.taskId === query.oaTaskId);
            if (account) return account;
        }
        if (query.plusLocalId) {
            const account = find((item) => item.plus?.localId === query.plusLocalId);
            if (account) return account;
        }
        if (query.plusRemoteJobId) {
            const account = find((item) => item.plus?.remoteJobId === query.plusRemoteJobId);
            if (account) return account;
        }
        if (tokenHashValue) {
            const account = find((item) =>
                item.accessToken?.hash === tokenHashValue
                || item.plus?.tokenHash === tokenHashValue
                || item.oa?.sourceAccessTokenHash === tokenHashValue,
            );
            if (account) return account;
        }
        if (phone) {
            const account = find((item) =>
                normalizePhone(item.phone) === phone
                || normalizePhone(item.accessToken?.phone) === phone,
            );
            if (account) return account;
        }
        if (email) {
            const account = find((item) => lower(item.emailBinding?.email) === email);
            if (account) return account;
        }
        if (workflowRunId) {
            const account = find((item) => item.workflow?.runId === workflowRunId);
            if (account) return account;
        }
        return undefined;
    }
}

export function createAccountLedger(dataDir: string): AccountLedger {
    return new AccountLedger(dataDir);
}
