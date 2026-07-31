import type { ModuleDefinition, ModuleContext } from "./types";
import { seedLinuxDoOAuthFromEnv } from "./oauth";
import { createAuthProvider } from "./auth-provider";
import { createPaymentProvider, LINUXDO_CHANNEL_ID, LINUXDO_PROVIDER } from "./payment-provider";
import { createSettingsContribution } from "./settings";
import { createAuthRoutes } from "./routes/auth";
import { createPaymentRoutes } from "./routes/payments";
import { setPaymentProvider } from "./routes/payment-bridge";

const definition: ModuleDefinition = {
  activate(ctx: ModuleContext) {
    seedLinuxDoOAuthFromEnv(ctx);

    ctx.ensurePaymentChannel({
      id: LINUXDO_CHANNEL_ID,
      provider: LINUXDO_PROVIDER,
      name: "LINUX DO Credit",
      gateway_url: "https://credit.linux.do/epay",
      exchange_rate_micros: 1_000_000,
      min_amount_minor: 100,
      max_amount_minor: 100_000,
    });

    const paymentProvider = createPaymentProvider(ctx);
    setPaymentProvider(ctx, paymentProvider);
    ctx.registerPaymentProvider(paymentProvider);
    ctx.registerAuthProvider(createAuthProvider(ctx));
    ctx.contributeAdminSettings(createSettingsContribution(ctx));
    ctx.mountUserRoutes(createAuthRoutes(ctx));
    ctx.mountPaymentRoutes(createPaymentRoutes(ctx));
  },

  deactivate(ctx: ModuleContext) {
    ctx.disablePaymentChannel(LINUXDO_CHANNEL_ID);
  },
};

export = definition;
