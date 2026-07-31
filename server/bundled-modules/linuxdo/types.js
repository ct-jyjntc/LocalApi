"use strict";
/**
 * Structural ModuleContext type used by the packaged module.
 * Must stay compatible with server/src/modules/types.ts ModuleContext.
 * Modules must not import express — use ctx.createRouter() instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
