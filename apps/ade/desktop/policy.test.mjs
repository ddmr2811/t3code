import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { assetPath, externalUrl } from "./policy.mjs";

const root = NodePath.resolve("/opt/ade/web");

describe("assetPath", () => {
  it.each([
    ["ade://app/", NodePath.join(root, "index.html")],
    ["ade://app/?hilo=abc", NodePath.join(root, "index.html")],
    ["ade://app/assets/index-1.js", NodePath.join(root, "assets/index-1.js")],
  ])("serves %s from the bundled web root", (url, file) => {
    expect(assetPath(root, url)).toBe(file);
  });

  it.each([
    "ade://app/..%2f..%2fetc%2fpasswd",
    "ade://app/%2e%2e%2fsecrets",
    "ade://app/%E0%A4%A",
    "ade://other/index.html",
    "https://evil.example/index.html",
  ])("refuses %s", (url) => {
    expect(assetPath(root, url)).toBeNull();
  });
});

describe("externalUrl", () => {
  it.each(["https://github.com/x", "http://100.101.102.103:3773/"])("opens %s outside", (url) => {
    expect(externalUrl(url)).toBe(url);
  });

  it.each([
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "ms-settings:privacy",
    "ade://app/",
    "not a url",
  ])("never hands %s to the system", (url) => {
    expect(externalUrl(url)).toBeNull();
  });
});
