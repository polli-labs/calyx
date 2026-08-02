import { describe, expect, test } from "vitest";
import {
  buildCalyxMcpActivityAttachmentsManifestV1,
  validateCalyxMcpActivityAttachmentsManifestV1
} from "../mcp-activity-attachments";

describe("Calyx MCP activity-attachments manifest", () => {
  test("emits metadata and image tool descriptors without write tools", () => {
    const manifest = buildCalyxMcpActivityAttachmentsManifestV1();

    expect(manifest.schema_version).toBe("calyx.mcp.activity-attachments/v0");
    expect(manifest.surface).toBe("activity-attachments");
    expect(manifest.validation.ok).toBe(true);
    expect(manifest.security.write_tools_exposed).toBe(false);
    expect(manifest.security.bytes_in_activity_projection).toBe(false);
    expect(manifest.security.image_tool_success_shape).toBe("image_only_content_block");
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "activity_attachments_list",
      "activity_attachment_record",
      "activity_attachment_image"
    ]);
    expect(manifest.tools.find((tool) => tool.name === "activity_attachment_image")?.output_schema_ref).toBe("McpImageContentBlock");
    for (const tool of manifest.tools) {
      expect(tool.read_only).toBe(true);
      expect(tool.input_schema.type).toBe("object");
      expect(JSON.stringify(tool.input_schema)).not.toContain("base64");
      expect(tool.backing_command.path).toBe("activity attachments");
      expect(tool.description.startsWith("Use when ")).toBe(true);
    }
  });

  test("fails validation when the activity backing command disappears", () => {
    const manifest = buildCalyxMcpActivityAttachmentsManifestV1();
    const validation = validateCalyxMcpActivityAttachmentsManifestV1(manifest.tools, {
      commandPaths: ["mcp serve"]
    });

    expect(validation.ok).toBe(false);
    expect(
      validation.checks.find((check) => check.id === "activity_attachment_image.command_path.activity.attachments")?.status
    ).toBe("error");
  });
});
