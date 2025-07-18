import { AbstractUploader, UploadAuditFile } from "@/base/AbstractUploader";
import { config } from "@/core/config";
import { Validator } from "@/core/validator";
import { logError } from "@/core/logger";
import { sleep } from "@/utils/sleep";
import { calculateSHA256 } from "@forest-protocols/sdk";
import { createClient, Session, SupabaseClient } from "@supabase/supabase-js";
import axios from "axios";

/**
 * Audit file uploader implementation for peerBench.
 */
export class PeerBenchUploader extends AbstractUploader {
  token?: string;
  supabaseClient?: SupabaseClient;
  apiURL: string;
  session: Session | null = null;

  private refreshTokenInterval?: NodeJS.Timeout;
  private isRefreshingToken = false;
  private isClosed = false;

  constructor(validator: Validator) {
    super(validator);

    this.supabaseClient = createClient(
      config.PEERBENCH_UPLOADER_SUPABASE_URL,
      config.PEERBENCH_UPLOADER_SUPABASE_ANON_KEY
    );
    this.apiURL = config.PEERBENCH_API_URL;
  }

  async init(): Promise<void> {
    if (!this.supabaseClient) {
      return;
    }

    const validatorConfig = config.validatorConfigurations[this.validator.tag];
    const privateKey = validatorConfig.validatorWalletPrivateKey;
    const email = `val-${this.validator.actorInfo.ownerAddr.toLowerCase()}@forest-ai.org`;
    const password = await calculateSHA256(
      this.validator.actorInfo.ownerAddr + privateKey
    );

    const authData =
      (await this.login(email, password)) ||
      (await this.signUp(email, password));

    this.session = authData?.session || null;
    this.token = this.session?.access_token;

    if (!this.token) {
      this.logger.error(
        `Failed authentication with PeerBench: No token received`
      );
      return;
    }
    this.logger.info(`Authenticated with PeerBench successfully`);

    // Refresh the token 15 minutes before it expires
    this.refreshTokenInterval = setInterval(
      () => this.refreshToken(),
      (this.session!.expires_in - 15 * 60) * 1000
    );
  }

  async refreshToken() {
    if (this.isClosed) {
      return;
    }

    if (this.isRefreshingToken) {
      this.logger.debug(`Token is already being refreshed`);
      return;
    }

    if (!this.supabaseClient) {
      clearInterval(this.refreshTokenInterval!);
      return;
    }

    this.isRefreshingToken = true;
    this.logger.info(`Refreshing token`);
    while (!this.isClosed) {
      try {
        const { data, error } = await this.supabaseClient.auth.refreshSession(
          this.session || undefined
        );
        if (error) {
          throw new Error(error.message);
        }

        this.session = data.session;
        this.token = this.session?.access_token;
        break;
      } catch (err) {
        logError({
          err,
          logger: this.logger,
          prefix: `Failed to refresh Supabase token`,
        });
        this.logger.info(`Retrying in 10 seconds`);
        await sleep(10_000);
      }
    }
    this.isRefreshingToken = false;
  }

  async upload(auditFiles: UploadAuditFile[]): Promise<void> {
    if (!this.token) {
      return;
    }
    try {
      const response = await axios.post(
        `${this.apiURL}/validation-sessions/upload`,
        { auditFiles },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
        }
      );

      if (response.status !== 200) {
        throw new Error(
          `Failed to upload validation sessions to PeerBench: Code ${
            response.status
          }: ${JSON.stringify(response.data)}`
        );
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        throw new Error(
          `Failed to upload validation sessions to PeerBench: ${
            err.message
          }: Code ${err.response?.status}: ${JSON.stringify(
            err.response?.data || {}
          )}`
        );
      }
    }
  }

  async close(): Promise<void> {
    if (!this.supabaseClient) {
      return;
    }

    if (this.refreshTokenInterval) {
      clearInterval(this.refreshTokenInterval);
    }

    this.isClosed = true;
  }

  private async login(email: string, password: string) {
    const { data, error } = await this.supabaseClient!.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.error(`Failed login to PeerBench`, {
        stacktrace: error,
      });
      return;
    }

    if (!data.session) {
      this.logger.debug(`No session returned from PeerBench authentication`);
      return;
    }

    return data;
  }

  private async signUp(email: string, password: string) {
    const { data, error } = await this.supabaseClient!.auth.signUp({
      email,
      password,
    });

    if (error) {
      this.logger.error(`Failed sign up to PeerBench`, {
        stacktrace: error,
      });
      return;
    }

    if (!data.session) {
      this.logger.debug(`No session returned from PeerBench sign up`);
      return;
    }

    return data;
  }
}
