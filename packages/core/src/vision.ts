import { createLogger } from "./log.js";
import { decodeJwt } from "./copilot.js";

const log = createLogger("vision");

export const UPLOAD_FILE_URL = "https://substrate.office.com/m365Copilot/UploadFile";
export const UPLOAD_VARIANTS = "feature.EnableImageSupportInUploadFile";
export const UPLOAD_OPTIONS_SETS = [
  "cwcgptvsan",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
];
export const IMAGE_FRAME_OPTIONS_SETS = ["gptvnorm2048"];

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface InputImage {
  mediaType: string;
  base64Data: string;
  fileName?: string;
}

export interface UploadedImageAnnotation {
  id: string;
  messageAnnotationMetadata: {
    "@type": "File";
    annotationType: "File";
    fileType: string;
    fileName: string;
  };
  messageAnnotationType: "ImageFile";
}

/**
 * Validate image media type and base64 payload.
 */
export function validateInputImage(img: InputImage): void {
  const normType = img.mediaType.toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(normType)) {
    throw new Error(
      `Unsupported image media type "${img.mediaType}". Supported: ${Array.from(SUPPORTED_IMAGE_TYPES).join(", ")}`,
    );
  }

  // Estimate byte size from base64 length
  const approxBytes = Math.round((img.base64Data.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image size (~${Math.round(approxBytes / (1024 * 1024))} MB) exceeds maximum allowed limit (${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB).`,
    );
  }
}

/**
 * Extract images from Anthropic message content blocks.
 */
export function extractAnthropicImages(content: unknown): InputImage[] {
  if (!Array.isArray(content)) return [];

  const images: InputImage[] = [];
  let index = 1;

  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "image") {
      const src = (block as any).source;
      if (src && src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") {
        const ext = src.media_type.split("/")[1] ?? "png";
        images.push({
          mediaType: src.media_type,
          base64Data: src.data,
          fileName: `image_${index++}.${ext}`,
        });
      }
    }
  }

  return images;
}

/**
 * Upload one image to Microsoft 365 Copilot Substrate UploadFile endpoint.
 * Returns the UploadedImageAnnotation carrying the server-assigned docId.
 */
export async function uploadImageToSubstrate(
  token: string,
  conversationId: string,
  image: InputImage,
  fetchFn: typeof fetch = fetch,
): Promise<UploadedImageAnnotation> {
  validateInputImage(image);

  let oid = "";
  let tid = "";
  try {
    const claims = decodeJwt(token);
    oid = claims.oid ?? "";
    tid = claims.tid ?? "";
  } catch {
    try {
      const payload = token.split(".")[1];
      if (payload) {
        const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const raw = JSON.parse(Buffer.from(padded, "base64").toString());
        oid = raw.oid ?? "";
        tid = raw.tid ?? "";
      }
    } catch {
      // ignore
    }
  }

  const dataUri = `data:${image.mediaType};base64,${image.base64Data}`;

  const form = new FormData();
  form.append("scenario", "UploadImage");
  form.append("conversationId", conversationId);
  form.append("FileBase64", dataUri);
  for (const opt of UPLOAD_OPTIONS_SETS) {
    form.append("optionsSets", opt);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-anchormailbox": `Oid:${oid}@${tid}`,
    "x-scenario": "copilotfile",
    "x-variants": UPLOAD_VARIANTS,
    Origin: "https://m365.cloud.microsoft",
  };

  log.info(`Uploading image (${image.mediaType}, ~${Math.round((image.base64Data.length * 3) / 4)} bytes) to ${UPLOAD_FILE_URL}`);

  const res = await fetchFn(UPLOAD_FILE_URL, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`M365 image upload failed (${res.status}): ${errorText}`);
  }

  const body = (await res.json()) as { docId?: string };
  const docId = body.docId;
  if (!docId) {
    throw new Error("M365 image upload succeeded but returned no docId");
  }

  log.info(`Image upload succeeded, docId: ${docId}`);

  return {
    id: docId,
    messageAnnotationMetadata: {
      "@type": "File",
      annotationType: "File",
      fileType: image.mediaType,
      fileName: image.fileName ?? "image.png",
    },
    messageAnnotationType: "ImageFile",
  };
}
