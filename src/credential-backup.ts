/**
 * Credential-backup compatibility boundary.
 *
 * Plaintext snapshots and automatic legacy reads are intentionally disabled.
 * Existing backup files are left untouched; no secure-store implementation
 * is currently qualified for non-overwriting writes or explicit recovery.
 */

export interface CredentialBackup {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
}

export interface CredentialBackupDisabled {
  saved: false;
  reason: "secure_store_not_implemented";
}

type CredentialAccount =
  | { appId?: string | null; clientSecret?: string | null; secretSource?: string | null }
  | undefined;

export const CREDENTIALS_MISSING_ERROR =
  "qqbot_credentials_missing: configure appId and clientSecret in OpenClaw config";

/**
 * clientSecretFile / --token-file is accepted by the config schema (as upstream does)
 * but no code path reads the file, so a file-only account can never authenticate.
 * Report that explicitly instead of a generic "missing" error.
 */
export const CLIENT_SECRET_FILE_UNSUPPORTED_ERROR =
  "qqbot_client_secret_file_unsupported: clientSecretFile (--token-file) is not read by this plugin build; " +
  "set clientSecret in the OpenClaw qqbot config (or QQBOT_CLIENT_SECRET for the default account) and remove clientSecretFile";

export const TOKEN_FILE_SETUP_UNSUPPORTED_ERROR =
  "QQBot --token-file is not supported by this plugin build (the file would never be read); " +
  "use --token appId:clientSecret or --use-env";

export function isCredentialConfigured(account: CredentialAccount): boolean {
  return Boolean(account?.appId && account.clientSecret);
}

/** Returns a secret-free, actionable error for an unusable credential config, or null. */
export function getCredentialConfigError(account: CredentialAccount): string | null {
  if (isCredentialConfigured(account)) return null;
  if (account?.secretSource === "file") {
    return account.appId
      ? CLIENT_SECRET_FILE_UNSUPPORTED_ERROR
      : `${CLIENT_SECRET_FILE_UNSUPPORTED_ERROR}; appId is also missing`;
  }
  return CREDENTIALS_MISSING_ERROR;
}

export function assertCredentialConfigured(account: CredentialAccount): void {
  const error = getCredentialConfigError(account);
  if (error) throw new Error(error);
}

/** Setup-time validation for `--token-file` used without a usable alternative. */
export function validateTokenFileSetupInput(
  input: { token?: string; tokenFile?: string; useEnv?: boolean },
): string | null {
  if (input.tokenFile && !input.token && !input.useEnv) return TOKEN_FILE_SETUP_UNSUPPORTED_ERROR;
  return null;
}

/** No credential data is persisted by this compatibility stub. */
export function saveCredentialBackup(
  _accountId: string,
  _appId: string,
  _clientSecret: string,
): CredentialBackupDisabled {
  return { saved: false, reason: "secure_store_not_implemented" };
}

/** Legacy plaintext files are not read, migrated, or deleted in v1. */
export function loadCredentialBackup(_accountId?: string): null {
  return null;
}
