// Injected at build time so an installed app cannot switch identity at runtime.
declare const __SYNC_VAULT_DEV__: boolean;
export const development = typeof __SYNC_VAULT_DEV__ !== "undefined" && __SYNC_VAULT_DEV__;
export const product = development ? "Sync Vault Dev" : "Sync Vault";
export const service = development ? "sync-vault-dev" : "sync-vault";
export const wireVersion = development ? 1001 : 1;
