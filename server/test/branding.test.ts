import assert from "node:assert/strict";
import test from "node:test";
import { applyBrandingToHtml, escapeHtml, jsonForInlineScript } from "../src/services/branding";

const SHELL = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>LocalAPI</title>
    <script>
      window.__LOCALAPI_BRANDING__ = /*__LOCALAPI_BRANDING__*/{};
    </script>
  </head>
  <body></body>
</html>`;

test("applyBrandingToHtml replaces the default title and boot payload", () => {
  const html = applyBrandingToHtml(SHELL, {
    brand_name: "Rainflow",
    company_name: "RF Co",
  });
  assert.match(html, /<title>Rainflow<\/title>/);
  assert.doesNotMatch(html, /<title>LocalAPI<\/title>/);
  assert.match(
    html,
    /window\.__LOCALAPI_BRANDING__ = \{"brand_name":"Rainflow","company_name":"RF Co"\}/,
  );
  assert.doesNotMatch(html, /\/\*__LOCALAPI_BRANDING__\*\//);
});

test("applyBrandingToHtml escapes a hostile brand name in title and script", () => {
  const html = applyBrandingToHtml(SHELL, {
    brand_name: "</title><script>alert(1)</script>",
    company_name: "",
  });
  assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/title\\u003e\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
});

test("applyBrandingToHtml injects a boot script when the placeholder is missing", () => {
  const html = applyBrandingToHtml(
    `<!doctype html><html><head><title>LocalAPI</title></head></html>`,
    { brand_name: "Acme", company_name: "" },
  );
  assert.match(html, /<title>Acme<\/title>/);
  assert.match(html, /<head><script>window\.__LOCALAPI_BRANDING__=\{"brand_name":"Acme","company_name":""\};<\/script>/);
});

test("jsonForInlineScript and escapeHtml keep markup inert", () => {
  assert.equal(escapeHtml(`a&b<c>"`), "a&amp;b&lt;c&gt;&quot;");
  assert.equal(jsonForInlineScript({ x: "</script>" }), '{"x":"\\u003c/script\\u003e"}');
});
