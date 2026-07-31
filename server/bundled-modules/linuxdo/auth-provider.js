"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthProvider = createAuthProvider;
const oauth_1 = require("./oauth");
function createAuthProvider(ctx) {
    return {
        id: "linuxdo",
        publicStatus() {
            const enabled = (0, oauth_1.isLinuxDoOAuthEnabled)(ctx);
            const registration = (ctx.getSetting("linuxdo_registration_enabled") ?? "true") === "true";
            return {
                linuxdo_enabled: enabled,
                linuxdo_login_enabled: enabled,
                linuxdo_registration_enabled: enabled && registration,
            };
        },
    };
}
