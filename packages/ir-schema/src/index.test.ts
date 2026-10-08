import { describe, expect, it } from "vitest";
import { countNodes, hexToColor, type IRNode } from "./index";

describe("IR helpers", () => {
  it("counts nested nodes", () => {
    const nodes: IRNode[] = [
      {
        id: "page",
        name: "Page",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        children: [
          {
            id: "text",
            name: "Text",
            type: "text",
            x: 0,
            y: 0,
            width: 50,
            height: 20,
            characters: "Hello",
          },
        ],
      },
    ];

    expect(countNodes(nodes)).toBe(2);
  });

  it("normalizes short hex colors", () => {
    expect(hexToColor("#0af")).toEqual({
      r: 0,
      g: 170 / 255,
      b: 1,
      a: 1,
    });
  });
});
