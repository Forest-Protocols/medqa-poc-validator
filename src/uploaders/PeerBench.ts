import { AbstractUploader, UploadAuditFile } from "@/base/AbstractUploader";
import { config } from "@/core/config";
import { Validator } from "@/core/validator";
import { calculateSHA256 } from "@forest-protocols/sdk";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import axios from "axios";

/**
 * Audit file uploader implementation for peerBench.
 */
export class PeerBenchUploader extends AbstractUploader {
  token?: string;
  supabaseClient?: SupabaseClient;
  apiURL: string;

  constructor(validator: Validator) {
    super(validator);

    // If there are defined environment variables, use them.
    // Otherwise use the default ones.
    this.supabaseClient = createClient(
      config.PEERBENCH_UPLOADER_SUPABASE_URL ||
        "https://bwnserbjjtxgkaydkmtk.supabase.co",
      config.PEERBENCH_UPLOADER_SUPABASE_ANON_KEY ||
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3bnNlcmJqanR4Z2theWRrbXRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU5OTczMDQsImV4cCI6MjA2MTU3MzMwNH0.hzPhuPtDYF1yMrKseoZX-P6ETpPEsGIC8mt-bieG6Kc"
    );
    this.apiURL =
      config.PEERBENCH_API_URL || "https://dev-peer-bench-js.vercel.app/api";
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

    this.token =
      (await this.login(email, password)) ||
      (await this.signUp(email, password));

    if (!this.token) {
      this.logger.error(
        `Failed authentication with PeerBench: No token received`
      );
      return;
    }
    this.logger.info(`Authenticated with PeerBench successfully`);
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
    // Nothing to do
  }

  private async login(email: string, password: string) {
    const { data, error } = await this.supabaseClient!.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.debug(`Failed login to PeerBench: ${error.message}`);
      return;
    }

    if (!data.session) {
      this.logger.debug(`No session returned from PeerBench authentication`);
      return;
    }

    return data.session.access_token;
  }

  private async signUp(email: string, password: string) {
    const { data, error } = await this.supabaseClient!.auth.signUp({
      email,
      password,
    });

    if (error) {
      this.logger.debug(`Failed sign up to PeerBench: ${error.message}`);
      return;
    }

    if (!data.session) {
      this.logger.debug(`No session returned from PeerBench sign up`);
      return;
    }

    return data.session.access_token;
  }
}
