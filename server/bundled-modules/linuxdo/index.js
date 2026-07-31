"use strict";
const oauth_1 = require("./oauth");
const auth_provider_1 = require("./auth-provider");
const payment_provider_1 = require("./payment-provider");
const settings_1 = require("./settings");
const auth_1 = require("./routes/auth");
const payments_1 = require("./routes/payments");
const payment_bridge_1 = require("./routes/payment-bridge");
const definition = {
    activate(ctx) {
        (0, oauth_1.seedLinuxDoOAuthFromEnv)(ctx);
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
        ctx.mountUserRoutes((0, auth_1.createAuthRoutes)(ctx));
        ctx.mountPaymentRoutes((0, payments_1.createPaymentRoutes)(ctx));
    },
    deactivate(ctx) {
        ctx.disablePaymentChannel(payment_provider_1.LINUXDO_CHANNEL_ID);
    },
};
module.exports = definition;
