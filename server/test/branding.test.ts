import assert from "node:assert/strict";
import test from "node:test";
import { applyBrandingToHtml, escapeHtml, jsonForInlineScript, sniffBrandIcon } from "../src/services/branding";

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
    /window\.__LOCALAPI_BRANDING__ = \{"brand_name":"Rainflow","brand_tagline":"","company_name":"RF Co","icon_url":null\}/,
  );
  assert.doesNotMatch(html, /\/\*__LOCALAPI_BRANDING__\*\//);
});

test("applyBrandingToHtml puts the tagline in the document title", () => {
  const html = applyBrandingToHtml(SHELL, {
    brand_name: "deepseek",
    brand_tagline: "开放平台",
    company_name: "",
  });
  assert.match(html, /<title>deepseek 开放平台<\/title>/);
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
  assert.match(html, /<head><script>window\.__LOCALAPI_BRANDING__=\{"brand_name":"Acme","brand_tagline":"","company_name":"","icon_url":null\};<\/script>/);
});

test("jsonForInlineScript and escapeHtml keep markup inert", () => {
  assert.equal(escapeHtml(`a&b<c>"`), "a&amp;b&lt;c&gt;&quot;");
  assert.equal(jsonForInlineScript({ x: "</script>" }), '{"x":"\\u003c/script\\u003e"}');
});

test("sniffBrandIcon accepts real images and rejects scripted SVG", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(sniffBrandIcon(png)?.mime, "image/png");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffBrandIcon(jpeg)?.mime, "image/jpeg");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(sniffBrandIcon(svg)?.mime, "image/svg+xml");
  const hostile = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffBrandIcon(hostile), null);
});

test("applyBrandingToHtml rewrites the favicon when an icon url is set", () => {
  const html = applyBrandingToHtml(
    `<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>LocalAPI</title></head></html>`,
    { brand_name: "Rainflow", company_name: "", icon_url: "/branding/icon?v=1" },
  );
  assert.match(html, /<link rel="icon" href="\/branding\/icon\?v=1" \/>/);
  assert.doesNotMatch(html, /href="\/favicon\.svg"/);
});
