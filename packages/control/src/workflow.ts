import type { Size } from '@control/contract';
import { fail } from '@control/problems';

// ComfyUI workflows in the API format (a JSON object of nodes, as POST /prompt accepts it) for experiment C0.
// This module only builds JSON. It does not contact a server, and it does not load or download models.
// Node class names and inputs are from ComfyUI core nodes: CheckpointLoaderSimple, CLIPTextEncode, EmptyLatentImage, KSampler,
// VAEDecode, SaveImage, LoadImage, ControlNetLoader, SetUnionControlNetType, and ControlNetApplyAdvanced.
// They were not run against a live ComfyUI server in C0. Check them on the first run.

export type GenerationSettings = {
  readonly checkpoint: string;
  readonly controlNet: string;
  readonly positive: string;
  readonly negative: string;
  readonly steps: number;
  readonly cfg: number;
  readonly sampler: string;
  readonly scheduler: string;
  readonly strength: number;
  readonly endPercent: number;
};

/**
 * Fixed C0 prompt. Tag order follows the Animagine XL 4.0 model card: subject, rating, other tags, quality tags.
 * The character is an adult. The prompt asks for a safe rating and the negative prompt excludes explicit content and minors.
 */
export const c0Prompt = {
  positive:
    '1girl, original, safe, adult woman, mature female, solo, full body, standing, three-quarter view, facing right, looking to the side, ' +
    'arms at sides, empty hands, visible hands, visible feet, short hair, black hair, fitted jacket, shorts, boots, plain white background, simple background, ' +
    'masterpiece, high score, great score, absurdres',
  negative:
    'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, ' +
    'signature, watermark, username, blurry, nsfw, explicit, nude, child, loli, aged down, multiple views, from behind, out of frame, cropped feet'
} as const;

/** Defaults from the Animagine XL 4.0 card (CFG 5, 28 steps, Euler Ancestral) and the xinsir pose card example (strength 1.0). */
export const c0Defaults = { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', strength: 1, endPercent: 1 } as const;

export const unionControlType = 'openpose';

function assertSettings(settings: GenerationSettings, size: Size, seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2 ** 32 - 1) fail('E_WORKFLOW_SEED', 'A seed must be an integer from 0 to 4294967295.');
  if (size.width % 8 !== 0 || size.height % 8 !== 0) fail('E_WORKFLOW_SIZE', 'The image size must be a multiple of 8 for the SDXL latent space.');
  if (!Number.isSafeInteger(settings.steps) || settings.steps < 1 || settings.steps > 150) fail('E_WORKFLOW_SETTINGS', 'steps must be an integer from 1 to 150.');
  if (!(settings.cfg > 0 && settings.cfg <= 30)) fail('E_WORKFLOW_SETTINGS', 'cfg must be above 0 and at most 30.');
  if (!(settings.strength >= 0 && settings.strength <= 2) || !(settings.endPercent > 0 && settings.endPercent <= 1))
    fail('E_WORKFLOW_SETTINGS', 'strength must be 0 to 2 and endPercent above 0 to 1.');
  for (const name of [settings.checkpoint, settings.controlNet]) {
    if (!/^[A-Za-z0-9._-]{1,200}\.safetensors$/.test(name)) fail('E_WORKFLOW_MODEL_NAME', 'A model file name must be a plain .safetensors file name without a path.');
  }
}

type Node = { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } };

/** The text-only baseline: the same model, prompt, size, and seed, without pose control. */
export function baselineWorkflow(settings: GenerationSettings, size: Size, seed: number, prefix: string): Record<string, Node> {
  assertSettings(settings, size, seed);
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: settings.checkpoint }, _meta: { title: 'Checkpoint' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: settings.positive, clip: ['1', 1] }, _meta: { title: 'Positive prompt' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: settings.negative, clip: ['1', 1] }, _meta: { title: 'Negative prompt' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: size.width, height: size.height, batch_size: 1 }, _meta: { title: 'Latent' } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: settings.steps,
        cfg: settings.cfg,
        sampler_name: settings.sampler,
        scheduler: settings.scheduler,
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0]
      },
      _meta: { title: 'Sampler' }
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] }, _meta: { title: 'Decode' } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix }, _meta: { title: 'Save' } }
  };
}

/** The pose-guided workflow: the baseline plus the union ControlNet in openpose mode on the pose image. */
export function poseWorkflow(settings: GenerationSettings, size: Size, seed: number, prefix: string, poseImage: string): Record<string, Node> {
  if (!/^[A-Za-z0-9._-]{1,200}\.png$/.test(poseImage)) fail('E_WORKFLOW_IMAGE_NAME', 'The pose image must be a plain .png file name in the ComfyUI input folder.');
  const graph = baselineWorkflow(settings, size, seed, prefix);
  graph['8'] = { class_type: 'LoadImage', inputs: { image: poseImage }, _meta: { title: 'Pose image' } };
  graph['9'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: settings.controlNet }, _meta: { title: 'Union ControlNet' } };
  graph['10'] = { class_type: 'SetUnionControlNetType', inputs: { control_net: ['9', 0], type: unionControlType }, _meta: { title: 'Union type' } };
  graph['11'] = {
    class_type: 'ControlNetApplyAdvanced',
    inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['10', 0], image: ['8', 0], strength: settings.strength, start_percent: 0, end_percent: settings.endPercent },
    _meta: { title: 'Apply pose control' }
  };
  const sampler = graph['5'] as Node;
  sampler.inputs.positive = ['11', 0];
  sampler.inputs.negative = ['11', 1];
  return graph;
}
