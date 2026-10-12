import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { PalaceError } from "./errors.ts";
import { normalizeBaseUrl } from "./provider-config-core.ts";
import { MAX_PORTRAIT_REFERENCE_BYTES, type PortraitReference } from "./portrait-reference.ts";

export const MAX_REFERENCE_PIXELS = 20_000_000;

export interface CharacterReferenceMetadata {
  sourceUrl: string;
  mode: "character";
  strength: number;
  fidelity: number;
  width: number;
  height: number;
}

/** 主人，本适配器的精确参考仅支持 NovelAI V4.5 系列；旧版 V5 配置会映射到对应的 V4.5 型号。 */
export function characterReferenceModel(configuredModel: string): string {
  switch (configuredModel.trim()) {
    case "nai-diffusion-5-full": return "nai-diffusion-4-5-full";
    case "nai-diffusion-5-curated": return "nai-diffusion-4-5-curated";
    case "nai-diffusion-4-5-full": return "nai-diffusion-4-5-full";
    case "nai-diffusion-4-5-curated": return "nai-diffusion-4-5-curated";
    default: throw new PalaceError(
      "角色头像参考需要 NovelAI V4.5 模型（nai-diffusion-4-5-full 或 nai-diffusion-4-5-curated）。请选择受支持的图片模型后重试。",
      400,
      "IMAGE_REFERENCE_UNSUPPORTED",
    );
  }
}

/** 主人，保留配置的 origin 和代理前缀；原生路由不使用 /v1 路径。 */
export function characterReferenceEndpoint(baseUrl: string, local = false): string {
  const normalized = normalizeBaseUrl(baseUrl, { local });
  const url = new URL(normalized);
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  url.pathname = `${prefix}/ai/generate-image`;
  return local ? normalized.slice(0, normalized.length - new URL(normalized).pathname.length) + url.pathname : url.toString();
}

function invalidReference(): PalaceError {
  return new PalaceError(
    "无法读取角色头像参考图。请重新生成头像后重试；参考图需为不超过 10 MiB、2000 万像素的 PNG、JPEG 或 WebP 图片。",
    400,
    "IMAGE_REFERENCE_INVALID",
  );
}

/** 主人，从支持的参考画布中选择最接近原图宽高比的尺寸。 */
function referenceCanvas(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  const canvases = [
    { width: 1024, height: 1536 },
    { width: 1472, height: 1472 },
    { width: 1536, height: 1024 },
  ];
  return canvases.reduce((best, canvas) =>
    Math.abs(Math.log(ratio / (canvas.width / canvas.height)))
      < Math.abs(Math.log(ratio / (best.width / best.height))) ? canvas : best,
  );
}

export async function buildCharacterReferenceRequest(
  configuredModel: string,
  prompt: string,
  reference: PortraitReference,
) {
  const model = characterReferenceModel(configuredModel);
  let encoded: string;
  let canvas: { width: number; height: number };
  try {
    if (!(reference.bytes instanceof Uint8Array) || reference.bytes.byteLength === 0
      || reference.bytes.byteLength > MAX_PORTRAIT_REFERENCE_BYTES) throw invalidReference();
    const input = sharp(reference.bytes, { limitInputPixels: MAX_REFERENCE_PIXELS, failOn: "warning" });
    const metadata = await input.metadata();
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)
      || reference.contentType !== `image/${metadata.format}`
      || (metadata.pages !== undefined && metadata.pages !== 1)) throw invalidReference();
    const { width, height } = metadata.autoOrient;
    if (!width || !height || width * height > MAX_REFERENCE_PIXELS) throw invalidReference();
    canvas = referenceCanvas(width, height);
    encoded = (await input.autoOrient().flatten({ background: "#000000" })
      .resize(canvas.width, canvas.height, { fit: "contain", background: "#000000" })
      .png().toBuffer()).toString("base64");
  } catch {
    throw invalidReference();
  }

  const details: CharacterReferenceMetadata = {
    sourceUrl: reference.sourceUrl,
    mode: "character",
    strength: 1,
    fidelity: 0.5,
    ...canvas,
  };
  // 主人，原生接口规范参见 NovelAI 文档，图片以原始 base64 PNG 格式传递。
  const body = {
    input: prompt,
    model,
    action: "generate",
    parameters: {
      params_version: 3,
      prompt,
      uc: "",
      qualityToggle: false,
      ucPreset: 3,
      add_original_image: false,
      width: 832,
      height: 1216,
      n_samples: 1,
      seed: randomBytes(4).readUInt32BE(0),
      steps: 28,
      scale: 5,
      sampler: "k_euler_ancestral",
      noise_schedule: "karras",
      sm: false,
      sm_dyn: false,
      negative_prompt: "",
      v4_prompt: {
        caption: { base_caption: prompt, char_captions: [] },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: "", char_captions: [] },
        legacy_uc: false,
      },
      director_reference_images: [encoded],
      director_reference_descriptions: [{ caption: { base_caption: "character", char_captions: [] } }],
      director_reference_information_extracted: [1],
      director_reference_strength_values: [details.strength],
      director_reference_secondary_strength_values: [details.fidelity],
    },
  };
  return { model, body, reference: details };
}
