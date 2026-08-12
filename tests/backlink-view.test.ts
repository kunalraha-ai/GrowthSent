import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BacklinkAnalyticsView from "../src/components/dashboard/BacklinkAnalyticsView";

test("backlink analytics search view renders its preview coverage and search form", () => {
  const html = renderToStaticMarkup(React.createElement(BacklinkAnalyticsView, { initialDomain: "github.com" }));

  assert.match(html, /Search a domain/);
  assert.match(html, /github\.com/);
  assert.match(html, /Preview coverage/);
  assert.match(html, /first 1,000 WAT files from CC-MAIN-2026-30/);
  assert.match(html, /not a full-web backlink index/);
  assert.match(html, /Search link observations/);
});
