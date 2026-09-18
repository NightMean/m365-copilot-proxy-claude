import { describe, it, expect } from "vitest";
import {
  validateInputImage,
  extractAnthropicImages,
  uploadImageToSubstrate,
  type InputImage,
  UPLOAD_FILE_URL,
} from "./vision.js";

describe("Vision Module", () => {
  it("validates supported image formats", () => {
    expect(() =>
      validateInputImage({
        mediaType: "image/png",
        base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }),
    ).not.toThrow();

    expect(() =>
      validateInputImage({
        mediaType: "image/jpeg",
        base64Data: "/9j/4AAQSkZJRg==",
      }),
    ).not.toThrow();

    expect(() =>
      validateInputImage({
        mediaType: "image/webp",
        base64Data: "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
      }),
    ).not.toThrow();
  });

  it("rejects unsupported image formats", () => {
    expect(() =>
      validateInputImage({
        mediaType: "image/svg+xml",
        base64Data: "PHN2Zz48L3N2Zz4=",
      }),
    ).toThrow(/Unsupported image media type/);

    expect(() =>
      validateInputImage({
        mediaType: "application/pdf",
        base64Data: "JVBERi0=",
      }),
    ).toThrow(/Unsupported image media type/);
  });

  it("extracts images from Anthropic message content blocks", () => {
    const blocks = [
      { type: "text", text: "Look at this screenshot:" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
      { type: "text", text: "What is wrong?" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "/9j/4AAQSkZJRg==",
        },
      },
    ];

    const images = extractAnthropicImages(blocks);
    expect(images).toHaveLength(2);
    expect(images[0].mediaType).toBe("image/png");
    expect(images[0].base64Data).toBe("iVBORw0KGgo=");
    expect(images[0].fileName).toBe("image_1.png");

    expect(images[1].mediaType).toBe("image/jpeg");
    expect(images[1].base64Data).toBe("/9j/4AAQSkZJRg==");
    expect(images[1].fileName).toBe("image_2.jpeg");
  });

  it("uploads image to Substrate and returns docId annotation", async () => {
    const mockToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      Buffer.from(
        JSON.stringify({
          oid: "user-123",
          tid: "tenant-456",
          aud: "https://substrate.office.com",
          iss: "https://login.microsoftonline.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url") +
      ".fake-signature";

    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(UPLOAD_FILE_URL);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${mockToken}`);
      expect(headers["x-anchormailbox"]).toBe("Oid:user-123@tenant-456");
      expect(headers["Origin"]).toBe("https://m365.cloud.microsoft");

      return {
        ok: true,
        status: 200,
        json: async () => ({ docId: "doc_test_uuid_789" }),
      } as Response;
    };

    const img: InputImage = {
      mediaType: "image/png",
      base64Data: "iVBORw0KGgo=",
      fileName: "screenshot.png",
    };

    const annotation = await uploadImageToSubstrate(mockToken, "conv-456", img, mockFetch as any);
    expect(annotation.id).toBe("doc_test_uuid_789");
    expect(annotation.messageAnnotationType).toBe("ImageFile");
    expect(annotation.messageAnnotationMetadata.fileName).toBe("screenshot.png");
    expect(annotation.messageAnnotationMetadata.fileType).toBe("image/png");
  });
});
