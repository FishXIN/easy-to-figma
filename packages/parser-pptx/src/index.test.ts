import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_OPTIONS } from "@easy-to-figma/ir-schema";
import { parsePptx } from "./index";

describe("parsePptx", () => {
  it("parses a text box into an editable text node", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    );
    zip.file(
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:p="p" xmlns:a="a">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr>
              <p:spPr>
                <a:xfrm><a:off x="95250" y="190500"/><a:ext cx="1905000" cy="476250"/></a:xfrm>
                <a:noFill/>
              </p:spPr>
              <p:txBody>
                <a:p>
                  <a:r><a:rPr sz="2400"/><a:t>Hello Figma</a:t></a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`,
    );

    const bytes = await zip.generateAsync({ type: "uint8array" });
    const document = await parsePptx(bytes, "sample.pptx", DEFAULT_PARSE_OPTIONS);
    const node = document.pages[0]?.children[0];

    expect(document.pages).toHaveLength(1);
    expect(document.pages[0]?.width).toBe(1280);
    expect(node?.type).toBe("text");
    expect(node?.x).toBe(10);
    expect(node && "characters" in node ? node.characters : "").toBe("Hello Figma");
  });

  it("preserves top-level z-order and grouped content", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    );
    zip.file(
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:p="p" xmlns:a="a">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:nvSpPr><p:cNvPr id="2" name="Back"/></p:nvSpPr>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr>
            </p:sp>
            <p:grpSp>
              <p:nvGrpSpPr><p:cNvPr id="3" name="Middle Group"/></p:nvGrpSpPr>
              <p:grpSpPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1905000"/><a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="1905000"/></a:xfrm></p:grpSpPr>
              <p:sp>
                <p:nvSpPr><p:cNvPr id="4" name="Grouped Shape"/></p:nvSpPr>
                <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:solidFill><a:srgbClr val="0D67D8"/></a:solidFill></p:spPr>
              </p:sp>
            </p:grpSp>
            <p:sp>
              <p:nvSpPr><p:cNvPr id="5" name="Front"/></p:nvSpPr>
              <p:spPr><a:xfrm><a:off x="1905000" y="1905000"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:solidFill><a:srgbClr val="111111"/></a:solidFill></p:spPr>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`,
    );

    const document = await parsePptx(
      await zip.generateAsync({ type: "uint8array" }),
      "groups.pptx",
      DEFAULT_PARSE_OPTIONS,
    );

    expect(document.pages[0]?.children.map((node) => node.name)).toEqual([
      "Back",
      "Middle Group",
      "Front",
    ]);
    const group = document.pages[0]?.children[1];
    expect(group?.type).toBe("group");
    expect(group && "children" in group ? group.children[0]?.name : "").toBe("Grouped Shape");
  });
});
