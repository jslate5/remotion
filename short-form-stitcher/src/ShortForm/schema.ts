import { z } from "zod";

export const ShortFormClipSchema = z.object({
  src: z.string(),
  durationInFrames: z.number().int().positive(),
});

export const ShortFormSchema = z.object({
  clips: z.array(ShortFormClipSchema),
});

export type ShortFormProps = z.infer<typeof ShortFormSchema>;
export type ShortFormClip = z.infer<typeof ShortFormClipSchema>;

export const SHORT_FORM_FPS = 30;
export const SHORT_FORM_WIDTH = 1080;
export const SHORT_FORM_HEIGHT = 1920;
