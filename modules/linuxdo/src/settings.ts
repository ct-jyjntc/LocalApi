import type { ModuleContext } from "./types";
import {
  getLinuxDoOAuthPublicConfig,
  updateLinuxDoOAuthConfig,
  type ModuleSettingsAccess,
} from "./oauth";

function asAccess(ctx: ModuleContext): ModuleSettingsAccess {
  return ctx;
}

export function createSettingsContribution(ctx: ModuleContext) {
  return {
    settingKeys: [
      "linuxdo_login_enabled",
      "linuxdo_client_id",
      "linuxdo_client_secret",
      "linuxdo_relay_url",
      "linuxdo_relay_secret",
      "linuxdo_registration_enabled",
    ],
    serialize() {
      const linuxdo = getLinuxDoOAuthPublicConfig(asAccess(ctx));
      return {
        linuxdo_login_enabled: linuxdo.enabled,
        linuxdo_client_id: linuxdo.client_id,
        linuxdo_client_secret_set: linuxdo.client_secret_set,
        linuxdo_relay_url: linuxdo.relay_url,
        linuxdo_relay_secret_set: linuxdo.relay_secret_set,
        linuxdo_configured: linuxdo.configured,
        linuxdo_callback_url: linuxdo.callback_url,
        linuxdo_authorize_ready: linuxdo.authorize_ready,
      };
    },
    apply(body: Record<string, unknown>) {
      const hasLinuxDoField =
        body.linuxdo_login_enabled !== undefined
        || body.linuxdo_client_id !== undefined
        || body.linuxdo_client_secret !== undefined
        || body.linuxdo_relay_url !== undefined
        || body.linuxdo_relay_secret !== undefined;
      if (!hasLinuxDoField) return;
      updateLinuxDoOAuthConfig(asAccess(ctx), {
        enabled: typeof body.linuxdo_login_enabled === "boolean" ? body.linuxdo_login_enabled : undefined,
        client_id: typeof body.linuxdo_client_id === "string" ? body.linuxdo_client_id : undefined,
        client_secret: typeof body.linuxdo_client_secret === "string" ? body.linuxdo_client_secret : undefined,
        relay_url: typeof body.linuxdo_relay_url === "string" ? body.linuxdo_relay_url : undefined,
        relay_secret: typeof body.linuxdo_relay_secret === "string" ? body.linuxdo_relay_secret : undefined,
      });
    },
  };
}
