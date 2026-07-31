"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setPaymentProvider = setPaymentProvider;
exports.getPaymentProvider = getPaymentProvider;
const providers = new WeakMap();
function setPaymentProvider(ctx, adapter) {
    providers.set(ctx, adapter);
}
function getPaymentProvider(ctx) {
    return providers.get(ctx) ?? null;
}
