import { describe, expect, it } from "vitest";
import { combineImageFilters, mapPsdAdjustment } from "./index";

describe("Photoshop adjustment mapping", () => {
  it("maps brightness, contrast and exposure to native Figma image sliders", () => {
    expect(
      mapPsdAdjustment({
        type: "brightness/contrast",
        brightness: 75,
        contrast: -50,
      }),
    ).toEqual({
      filters: {
        exposure: 0.5,
        contrast: -0.5,
      },
      mapped: ["brightness→exposure", "contrast"],
      unsupported: [],
    });

    expect(
      mapPsdAdjustment({
        type: "exposure",
        exposure: 10,
        gamma: 0.4,
        offset: 0.1,
      }).filters,
    ).toEqual({
      exposure: 0.5,
      shadows: 0.19999999999999998,
      highlights: 0.4,
    });
  });

  it("approximates tonal levels with shadows, highlights, exposure and contrast", () => {
    const mapping = mapPsdAdjustment({
      type: "levels",
      rgb: {
        shadowInput: 10,
        highlightInput: 245,
        shadowOutput: 5,
        highlightOutput: 250,
        midtoneInput: 0.8,
      },
    });

    expect(mapping.filters.shadows).toBeCloseTo(-5 / 255);
    expect(mapping.filters.highlights).toBeCloseTo(5 / 255);
    expect(mapping.filters.exposure).toBeCloseTo(0.1);
    expect(mapping.filters.contrast).toBeCloseTo(255 / 235 - 1);
    expect(mapping.unsupported).toEqual([]);
  });

  it("reports adjustments with no equivalent Figma image slider", () => {
    expect(mapPsdAdjustment({ type: "invert" })).toEqual({
      filters: {},
      mapped: [],
      unsupported: ["invert"],
    });
  });

  it("ignores Photoshop's zero-value color channel defaults", () => {
    const mapping = mapPsdAdjustment({
      type: "hue/saturation",
      master: { a: 0, b: -158, c: 25, d: 0, hue: 0, saturation: 13, lightness: 0 },
      reds: { a: 315, b: 345, c: 15, d: 45, hue: 0, saturation: 0, lightness: 0 },
      yellows: { a: 15, b: 45, c: 75, d: 105, hue: 0, saturation: 0, lightness: 0 },
    });

    expect(mapping.filters).toEqual({ saturation: 0.13, exposure: 0 });
    expect(mapping.unsupported).toEqual([]);
  });

  it("maps the active color-balance axes without flagging zero tonal ranges", () => {
    const mapping = mapPsdAdjustment({
      type: "color balance",
      shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: -20 },
      highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    });

    expect(mapping.filters.temperature).toBeCloseTo(0.45);
    expect(mapping.filters.tint).toBeCloseTo(0.25);
    expect(mapping.unsupported).toEqual([]);
  });

  it("combines and clamps stacked native filters", () => {
    expect(
      combineImageFilters(
        { exposure: 0.7, contrast: -0.4 },
        { exposure: 0.6, saturation: 0.25 },
      ),
    ).toEqual({
      exposure: 1,
      contrast: -0.4,
      saturation: 0.25,
    });
  });
});
