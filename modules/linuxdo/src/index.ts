import type { ModuleDefinition, ModuleContext } from "./types";
import { seedLinuxDoOAuthFromEnv } from "./oauth";
import { createAuthProvider } from "./auth-provider";
import { createPaymentProvider, LINUXDO_CHANNEL_ID, LINUXDO_PROVIDER } from "./payment-provider";
import { createSettingsContribution } from "./settings";
import { createAuthRoutes } from "./routes/auth";
import { createPaymentRoutes } from "./routes/payments";
import { setPaymentProvider } from "./routes/payment-bridge";

// Deactivate → activate cycles must not permanently kill the payment channel:
// remember whether it was enabled before deactivation so activate can restore it.
let wasChannelEnabledBeforeDeactivate = false;
let authRoutesCleanup: (() => void) | null = null;

const definition: ModuleDefinition = {
  activate(ctx: ModuleContext) {
    seedLinuxDoOAuthFromEnv(ctx);

    // Restore the channel after a deactivate→activate cycle. A channel the
    // admin never enabled (or explicitly disabled) stays disabled.
    if (wasChannelEnabledBeforeDeactivate) {
      const channel = ctx.getPaymentChannel(LINUXDO_CHANNEL_ID);
      if (channel && !channel.enabled) ctx.enablePaymentChannel(LINUXDO_CHANNEL_ID);
    }
    wasChannelEnabledBeforeDeactivate = false;

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
    const authRoutes = createAuthRoutes(ctx);
    authRoutesCleanup = authRoutes.cleanup;
    ctx.mountUserRoutes(authRoutes.router);
    ctx.mountPaymentRoutes(createPaymentRoutes(ctx));
  },

  deactivate(ctx: ModuleContext) {
    authRoutesCleanup?.();
    authRoutesCleanup = null;
    const channel = ctx.getPaymentChannel(LINUXDO_CHANNEL_ID);
    wasChannelEnabledBeforeDeactivate = channel?.enabled === 1;
    if (wasChannelEnabledBeforeDeactivate) {
      ctx.disablePaymentChannel(LINUXDO_CHANNEL_ID);
    }
  },
};

export = definition;
