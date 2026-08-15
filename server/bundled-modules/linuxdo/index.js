"use strict";
const oauth_1 = require("./oauth");
const auth_provider_1 = require("./auth-provider");
const payment_provider_1 = require("./payment-provider");
const settings_1 = require("./settings");
const auth_1 = require("./routes/auth");
const payments_1 = require("./routes/payments");
const payment_bridge_1 = require("./routes/payment-bridge");
// Deactivate → activate cycles must not permanently kill the payment channel:
// remember whether it was enabled before deactivation so activate can restore it.
let wasChannelEnabledBeforeDeactivate = false;
let authRoutesCleanup = null;
const definition = {
    activate(ctx) {
        (0, oauth_1.seedLinuxDoOAuthFromEnv)(ctx);
        // Restore the channel after a deactivate→activate cycle. A channel the
        // admin never enabled (or explicitly disabled) stays disabled.
        if (wasChannelEnabledBeforeDeactivate) {
            const channel = ctx.getPaymentChannel(payment_provider_1.LINUXDO_CHANNEL_ID);
            if (channel && !channel.enabled)
                ctx.enablePaymentChannel(payment_provider_1.LINUXDO_CHANNEL_ID);
        }
        wasChannelEnabledBeforeDeactivate = false;
        ctx.ensurePaymentChannel({
            id: payment_provider_1.LINUXDO_CHANNEL_ID,
            provider: payment_provider_1.LINUXDO_PROVIDER,
            name: "LINUX DO Credit",
            gateway_url: "https://credit.linux.do/epay",
            exchange_rate_micros: 1_000_000,
            min_amount_minor: 100,
            max_amount_minor: 100_000,
        });
        const paymentProvider = (0, payment_provider_1.createPaymentProvider)(ctx);
        (0, payment_bridge_1.setPaymentProvider)(ctx, paymentProvider);
        ctx.registerPaymentProvider(paymentProvider);
        ctx.registerAuthProvider((0, auth_provider_1.createAuthProvider)(ctx));
        ctx.contributeAdminSettings((0, settings_1.createSettingsContribution)(ctx));
        const authRoutes = (0, auth_1.createAuthRoutes)(ctx);
        authRoutesCleanup = authRoutes.cleanup;
        ctx.mountUserRoutes(authRoutes.router);
        ctx.mountPaymentRoutes((0, payments_1.createPaymentRoutes)(ctx));
    },
    deactivate(ctx) {
        authRoutesCleanup?.();
        authRoutesCleanup = null;
        const channel = ctx.getPaymentChannel(payment_provider_1.LINUXDO_CHANNEL_ID);
        wasChannelEnabledBeforeDeactivate = channel?.enabled === 1;
        if (wasChannelEnabledBeforeDeactivate) {
            ctx.disablePaymentChannel(payment_provider_1.LINUXDO_CHANNEL_ID);
        }
    },
};
module.exports = definition;
