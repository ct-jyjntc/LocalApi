"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsContribution = createSettingsContribution;
const oauth_1 = require("./oauth");
function asAccess(ctx) {
    return ctx;
}
function createSettingsContribution(ctx) {
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
            const linuxdo = (0, oauth_1.getLinuxDoOAuthPublicConfig)(asAccess(ctx));
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
        apply(body) {
            const hasLinuxDoField = body.linuxdo_login_enabled !== undefined
                || body.linuxdo_client_id !== undefined
                || body.linuxdo_client_secret !== undefined
                || body.linuxdo_relay_url !== undefined
                || body.linuxdo_relay_secret !== undefined;
            if (!hasLinuxDoField)
                return;
            (0, oauth_1.updateLinuxDoOAuthConfig)(asAccess(ctx), {
                enabled: typeof body.linuxdo_login_enabled === "boolean" ? body.linuxdo_login_enabled : undefined,
                client_id: typeof body.linuxdo_client_id === "string" ? body.linuxdo_client_id : undefined,
                client_secret: typeof body.linuxdo_client_secret === "string" ? body.linuxdo_client_secret : undefined,
                relay_url: typeof body.linuxdo_relay_url === "string" ? body.linuxdo_relay_url : undefined,
                relay_secret: typeof body.linuxdo_relay_secret === "string" ? body.linuxdo_relay_secret : undefined,
            });
        },
    };
}
