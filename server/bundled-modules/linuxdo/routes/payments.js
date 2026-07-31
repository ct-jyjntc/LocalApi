"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPaymentRoutes = createPaymentRoutes;
const payment_bridge_1 = require("./payment-bridge");
function createPaymentRoutes(ctx) {
    const router = ctx.createRouter();
    router.get("/payment/linuxdo/notify", (req, res) => {
        try {
            const provider = (0, payment_bridge_1.getPaymentProvider)(ctx);
            if (!provider?.handleNotify) {
                throw ctx.paymentError(503, "payment_module_unavailable", "LinuxDo payment module is not active");
            }
            provider.handleNotify(req.query);
            res.type("text/plain").status(200).send("success");
        }
        catch (error) {
            const status = typeof error === "object" && error && "status" in error
                ? Number(error.status) || 500
                : 500;
            const message = error instanceof Error ? error.message : "Payment notification failed";
            res.type("text/plain").status(status).send(message);
        }
    });
    router.get("/payment/linuxdo/checkout/:orderNo", (req, res) => {
        try {
            const provider = (0, payment_bridge_1.getPaymentProvider)(ctx);
            if (!provider?.getCheckout) {
                throw ctx.paymentError(503, "payment_module_unavailable", "LinuxDo payment module is not active");
            }
            const submission = provider.getCheckout(req.params.orderNo);
            // Duplicate merchant order submissions hit LinuxDo unique index; keep hard lock.
            ctx.renderPaymentCheckoutPage(res, submission, "LINUX DO Credit", { allowRetry: false });
        }
        catch (error) {
            const status = typeof error === "object" && error && "status" in error
                ? Number(error.status) || 500
                : 500;
            const message = error instanceof Error ? error.message : "Unable to prepare payment";
            res.status(status).type("text/plain").send(message);
        }
    });
    return router;
}
