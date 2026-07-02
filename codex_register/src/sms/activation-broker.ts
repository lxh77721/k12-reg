import type {
  SmsActivation,
  SmsProvider,
  SmsVerificationCode,
} from "./provider.js";

const ACTIVATION_CANCEL_AND_WITHDRAW_MIN_AGE_MS = 2 * 60 * 1000;

export type ActivationAttemptOutcome = "success" | "failed";

export interface ActivationUsageStats {
  activationId: string;
  phoneNumber: string;
  startedAttemptCount: number;
  finishedAttemptCount: number;
  successCount: number;
  failureCount: number;
  requestedAnotherSmsCount: number;
  lastOutcome?: ActivationAttemptOutcome;
  lastActivationAt?: Date;
  lastAttemptStartedAt?: Date;
  lastAttemptFinishedAt?: Date;
}

export interface PhoneUsageStats {
  phoneNumber: string;
  activationCount: number;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  completedActivationCount: number;
  withdrawnActivationCount: number;
  discardedActivationCount: number;
  lastActivationId?: string;
  lastOutcome?: ActivationAttemptOutcome;
  firstUsedAt?: Date;
  lastUsedAt?: Date;
}

export interface ActivationBrokerHistoryStats {
  totalActivationsAllocated: number;
  totalAttemptsStarted: number;
  totalAttemptsSucceeded: number;
  totalAttemptsFailed: number;
  totalRequestedAnotherSms: number;
  totalCompletedActivations: number;
  totalWithdrawnActivations: number;
  totalDiscardedActivations: number;
  phoneStats: Record<string, PhoneUsageStats>;
}

export interface ActivationLease extends SmsActivation {
  isNewActivation: boolean;
  requestedAnotherSms: boolean;
  round: number;
  waitForVerificationCode(): Promise<SmsVerificationCode>;
}

export interface ISMSActivationBroker {
  getActivation(): Promise<ActivationLease>;
  markAsSucceed(): Promise<void>;
  markAsFailed(rotate?: boolean): Promise<void>;
  cancelCurrentActivation(): Promise<string>;
}

export interface ActivationBrokerState<Activation extends SmsActivation> {
  currentActivation: Activation | null;
  needsAnotherSms: boolean;
  attemptActive: boolean;
  round: number;
  usage: ActivationUsageStats | null;
  lastReleasedUsage: ActivationUsageStats | null;
  history: ActivationBrokerHistoryStats;
}

function getExpiryTime(expiresAt?: Date): number | null {
  if (!expiresAt) {
    return null;
  }

  const timestamp = expiresAt.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getActivationAgeMs(createdAt?: Date): number | null {
  if (!createdAt) {
    return null;
  }

  const timestamp = createdAt.getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Date.now() - timestamp;
}

export class ActivationBroker<
  Activation extends SmsActivation = SmsActivation,
  Verification extends SmsVerificationCode = SmsVerificationCode,
> implements ISMSActivationBroker {
  private currentActivation: Activation | null = null;
  private needsAnotherSms = false;
  private attemptActive = false;
  private round = 0;
  private usage: ActivationUsageStats | null = null;
  private lastReleasedUsage: ActivationUsageStats | null = null;
  private activations: ActivationUsageStats[] = []
  private history: ActivationBrokerHistoryStats = {
    totalActivationsAllocated: 0,
    totalAttemptsStarted: 0,
    totalAttemptsSucceeded: 0,
    totalAttemptsFailed: 0,
    totalRequestedAnotherSms: 0,
    totalCompletedActivations: 0,
    totalWithdrawnActivations: 0,
    totalDiscardedActivations: 0,
    phoneStats: {},
  };

  constructor(
    private readonly provider: SmsProvider<Activation, Verification>,
  ) {}

  getState(): ActivationBrokerState<Activation> {
    return {
      currentActivation: this.currentActivation,
      needsAnotherSms: this.needsAnotherSms,
      attemptActive: this.attemptActive,
      round: this.round,
      usage: this.usage,
      lastReleasedUsage: this.lastReleasedUsage,
      history: this.getHistory(),
    };
  }

  getUsage(): ActivationUsageStats | null {
    return this.usage;
  }

  getHistory(): ActivationBrokerHistoryStats {
    return {
      ...this.history,
      phoneStats: Object.fromEntries(
        Object.entries(this.history.phoneStats).map(([phoneNumber, stats]) => [
          phoneNumber,
          { ...stats },
        ]),
      ),
    };
  }

  debugGetCurrentActivation(): Activation | null {
    return this.currentActivation;
  }

  async getActivation(): Promise<ActivationLease> {
    if (!this.currentActivation || this.isExpired(this.currentActivation)) {
      const activation = await this.provider.requestActivation();
      this.activate(activation);
      this.startAttempt();
      return this.buildLease(activation, true, false);
    }

    let requestedAnotherSms = false;
    if (this.needsAnotherSms) {
      if (
        // this.currentActivation.canRequestAnotherSms === false ||
        this.isExpired(this.currentActivation)
      ) {
        const activation = await this.provider.requestActivation();
        this.activate(activation);
        this.startAttempt();
        return this.buildLease(activation, true, false);
      }
      console.log(
        `[pollSMSCode] 复用号码[+${this.currentActivation.phoneNumber}]，第 ${(this.usage?.finishedAttemptCount ?? 0) + 1} 次， round=${this.round + 1}`,
      );

      await this.provider.requestAnotherSms(
        this.currentActivation.activationId,
      );
      this.needsAnotherSms = false;
      this.round += 1;
      requestedAnotherSms = true;
      if (this.usage) {
        this.usage.requestedAnotherSmsCount += 1;
      }
      this.history.totalRequestedAnotherSms += 1;
    }

    this.startAttempt();
    return this.buildLease(this.currentActivation, false, requestedAnotherSms);
  }

  async markAsSucceed(): Promise<void> {
    await this.finishAttempt("success");
  }

  async markAsFailed(rotate?: boolean): Promise<void> {
    await this.finishAttempt("failed", rotate);
  }

  private async finishAttempt(outcome: ActivationAttemptOutcome, rotate?: boolean): Promise<void> {
    const activation = this.currentActivation;
    if (!activation || !this.usage) {
      throw new Error("当前没有可结束的 activation");
    }

    if (!this.attemptActive) {
      throw new Error("当前没有进行中的 attempt");
    }

    this.attemptActive = false;
    this.usage.finishedAttemptCount += 1;
    this.usage.lastOutcome = outcome;
    this.usage.lastAttemptFinishedAt = new Date();
    if (outcome === "success") {
      this.usage.successCount += 1;
      this.history.totalAttemptsSucceeded += 1;
    } else {
      this.usage.failureCount += 1;
      this.history.totalAttemptsFailed += 1;
    }
    this.recordPhoneAttemptOutcome(activation.phoneNumber, activation.activationId, outcome);
    console.log(
      `[pollSMSCode] 本轮尝试完成 phone=+${activation.phoneNumber} outcome=${outcome} round=${this.round} 成功/失败=${this.getPhoneStats(activation.phoneNumber).successCount}/${this.getPhoneStats(activation.phoneNumber).failureCount}`,
    );

    // 经测试，短时间内同一个有效号码可以使用 1-3 次，超出必然引发 phone_max_usage_exceeded 错误。
    // 因此判断成功数 >= 3 进行 reset
    // 至于 failureCount，失败只会进入新一轮，多次失败不会有什么影响，仅添加一个上限防止无限失败，以求尽可能复用同一个号码
    if (
      rotate ||
      // activation.canRequestAnotherSms === false ||
      this.isExpired(activation) ||
      this.usage.successCount >= 3 ||
      this.usage.failureCount >= 3
    ) {
      await this.rotateActivation(outcome, { forceCancelAndWithdraw: Boolean(rotate) })
      return;
    }

    this.needsAnotherSms = true;
  }

  async rotateActivation(
    outcome: ActivationAttemptOutcome,
    options: { forceCancelAndWithdraw?: boolean } = {},
  ) {
      const activation = this.currentActivation!;
      const usage = this.usage!;
      // Release rule:
      // - if this activation has ever succeeded, it must be completed
      // - forced rotates are explicit换号/cancel场景，zero-success activation 要立即退回
      // - otherwise only activations with zero successes and age >= 2 minutes
      //   are eligible for cancelAndWithdraw
      // 轮换判断与 sms provider 强相关，暂时放在 broker 中
      const shouldCancelAndWithdraw =
        outcome === "failed" && usage.successCount === 0 &&
        (options.forceCancelAndWithdraw ||
          (getActivationAgeMs(usage.lastActivationAt) ?? 0) >=
          ACTIVATION_CANCEL_AND_WITHDRAW_MIN_AGE_MS);

      const action = shouldCancelAndWithdraw ? 'withdraw' : 'complete'
      if (shouldCancelAndWithdraw) {
        await this.cancelCurrentActivation()
      } else {
        await this.completeCurrentActivation()
      }
      console.log(
        `[pollSMSCode] 轮换中，对 +${activation.phoneNumber} 进行 ${action}，累计成功/失败=${usage.successCount}/${usage.failureCount}`,
      );
  }

  async completeCurrentActivation(): Promise<string> {
    const activation = this.requireCurrentActivation();
    try {
      const result = await this.provider.completeActivation(activation.activationId);
      this.history.totalCompletedActivations += 1;
      this.recordPhoneRelease(activation.phoneNumber, "complete");
      return result;
    } finally {
      this.reset();
    }
  }

  async cancelCurrentActivation(): Promise<string> {
    const activation = this.requireCurrentActivation();
    try {
      const result = await this.provider.cancelActivation(activation.activationId);
      this.history.totalDiscardedActivations += 1;
      this.recordPhoneRelease(activation.phoneNumber, "discard");
      return result;
    } finally {
      this.reset();
    }
  }

  discardCurrentActivation(): void {
    if (this.currentActivation) {
      this.history.totalDiscardedActivations += 1;
      this.recordPhoneRelease(this.currentActivation.phoneNumber, "discard");
    }
    this.reset();
  }

  private requireCurrentActivation(): Activation {
    if (!this.currentActivation) {
      throw new Error("当前没有可用 activation");
    }

    return this.currentActivation;
  }

  private isExpired(activation: Activation): boolean {
    const expiresAtMs = getExpiryTime(activation.expiresAt);
    return expiresAtMs != null && Date.now() >= expiresAtMs;
  }

  private startAttempt(): void {
    if (this.attemptActive) {
      throw new Error("当前 attempt 尚未结束，不能重复获取 activation");
    }

    this.attemptActive = true;
    if (this.usage) {
      this.usage.startedAttemptCount += 1;
      this.usage.lastAttemptStartedAt = new Date();
    }
    this.history.totalAttemptsStarted += 1;
    if (this.currentActivation) {
      this.recordPhoneAttemptStart(
        this.currentActivation.phoneNumber,
        this.currentActivation.activationId,
      );
      console.log(
        `[pollSMSCode] 进行新一轮尝试 activationId=${this.currentActivation.activationId} phone=+${this.currentActivation.phoneNumber} round=${this.round} activationAttempts=${this.usage?.startedAttemptCount ?? 0} totalAttempts=${this.history.totalAttemptsStarted}`,
      );
    }
  }

  private activate(activation: Activation): void {
    if (this.usage) {
      this.lastReleasedUsage = { ...this.usage };
      this.activations.push(this.usage)
    }

    this.currentActivation = activation;
    this.needsAnotherSms = false;
    this.attemptActive = false;
    this.round = 1;
    this.history.totalActivationsAllocated += 1;
    this.recordPhoneActivation(activation.phoneNumber, activation.activationId);
    this.usage = {
      activationId: activation.activationId,
      phoneNumber: activation.phoneNumber,
      startedAttemptCount: 0,
      finishedAttemptCount: 0,
      successCount: 0,
      failureCount: 0,
      requestedAnotherSmsCount: 0,
      lastActivationAt: new Date(),
    };
  }

  private buildLease(
    activation: Activation,
    isNewActivation: boolean,
    requestedAnotherSms: boolean,
  ): ActivationLease {
    return {
      activationId: activation.activationId,
      phoneNumber: activation.phoneNumber,
      expiresAt: activation.expiresAt,
      canRequestAnotherSms: activation.canRequestAnotherSms,
      isNewActivation,
      requestedAnotherSms,
      round: this.round,
      waitForVerificationCode: async () => {
        try {
          const verification = await this.provider.waitForVerificationCode(
            activation.activationId,
          );
          await this.markAsSucceed();
          return {
            code: verification.code,
            source: verification.source,
            text: verification.text,
            receivedAt: verification.receivedAt,
            rawStatus: verification.rawStatus,
          };
        } catch (e) {
          await this.markAsFailed();
          throw e;
        }
      },
    };
  }

  private reset(): void {
    if (this.usage) {
      this.lastReleasedUsage = { ...this.usage };
    }
    this.currentActivation = null;
    this.needsAnotherSms = false;
    this.attemptActive = false;
    this.round = 0;
    this.usage = null;
  }

  private getPhoneStats(phoneNumber: string): PhoneUsageStats {
    const normalizedPhoneNumber = String(phoneNumber).trim();
    const existing = this.history.phoneStats[normalizedPhoneNumber];
    if (existing) {
      return existing;
    }

    const created: PhoneUsageStats = {
      phoneNumber: normalizedPhoneNumber,
      activationCount: 0,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      completedActivationCount: 0,
      withdrawnActivationCount: 0,
      discardedActivationCount: 0,
    };
    this.history.phoneStats[normalizedPhoneNumber] = created;
    return created;
  }

  private recordPhoneActivation(phoneNumber: string, activationId: string): void {
    const stats = this.getPhoneStats(phoneNumber);
    const now = new Date();
    stats.activationCount += 1;
    stats.lastActivationId = activationId;
    stats.firstUsedAt ??= now;
    stats.lastUsedAt = now;
  }

  private recordPhoneAttemptStart(phoneNumber: string, activationId: string): void {
    const stats = this.getPhoneStats(phoneNumber);
    const now = new Date();
    stats.attemptCount += 1;
    stats.lastActivationId = activationId;
    stats.firstUsedAt ??= now;
    stats.lastUsedAt = now;
  }

  private recordPhoneAttemptOutcome(
    phoneNumber: string,
    activationId: string,
    outcome: ActivationAttemptOutcome,
  ): void {
    const stats = this.getPhoneStats(phoneNumber);
    const now = new Date();
    if (outcome === "success") {
      stats.successCount += 1;
    } else {
      stats.failureCount += 1;
    }
    stats.lastActivationId = activationId;
    stats.lastOutcome = outcome;
    stats.firstUsedAt ??= now;
    stats.lastUsedAt = now;
  }

  private recordPhoneRelease(
    phoneNumber: string,
    releaseMode: "complete" | "withdraw" | "discard",
  ): void {
    const stats = this.getPhoneStats(phoneNumber);
    const now = new Date();
    if (releaseMode === "complete") {
      stats.completedActivationCount += 1;
    } else if (releaseMode === "withdraw") {
      stats.withdrawnActivationCount += 1;
    } else {
      stats.discardedActivationCount += 1;
    }
    stats.firstUsedAt ??= now;
    stats.lastUsedAt = now;
  }
}
