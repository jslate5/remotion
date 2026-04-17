import crypto from "node:crypto";

export const sha256 = (input: string): string => {
  return crypto.createHash("sha256").update(input).digest("hex");
};

export const hashClipSequence = (clipIds: string[]): string => {
  return sha256(clipIds.join("|"));
};

export const clipIdFor = (bucket: string, filename: string): string => {
  return sha256(`${bucket}::${filename}`).slice(0, 16);
};

export const newPlanId = (): string => {
  return crypto.randomUUID();
};

export const newTemplateId = (name: string): string => {
  return sha256(`template::${name}`).slice(0, 16);
};

export function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
