import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { ThemeControl } from "./theme-control";

it("offers all three modes with system as the initial preference", () => {
  const html = renderToStaticMarkup(<ThemeControl />);
  expect(html).toContain('value="light"');
  expect(html).toContain('value="dark"');
  expect(html).toContain('value="system" selected=""');
  expect(html).toContain('aria-label="Giao diện"');
});
