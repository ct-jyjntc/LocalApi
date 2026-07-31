import type { AuthProviderAdapter, ModuleContext } from "./types";
import { isLinuxDoOAuthEnabled } from "./oauth";

export function createAuthProvider(ctx: ModuleContext): AuthProviderAdapter {
  return {
    id: "linuxdo",
    publicStatus() {
      const enabled = isLinuxDoOAuthEnabled(ctx);
      const registration = (ctx.getSetting("linuxdo_registration_enabled") ?? "true") === "true";
      return {
        linuxdo_enabled: enabled,
        linuxdo_login_enabled: enabled,
        linuxdo_registration_enabled: enabled && registration,
      };
    },
  };
}
