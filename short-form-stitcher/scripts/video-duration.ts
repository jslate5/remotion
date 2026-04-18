import { getVideoMetadata } from "@remotion/renderer";

// Probe the duration of a local video file in seconds.
// Uses Remotion's bundled ffprobe (via @remotion/renderer), so no system
// ffmpeg install is required and no brittle mediabunny CJS path is used.
export const getVideoDurationSeconds = async (
  absolutePath: string,
): Promise<number> => {
  const metadata = await getVideoMetadata(absolutePath, {
    logLevel: "error",
  });

  if (metadata.durationInSeconds == null) {
    throw new Error(
      `ffprobe could not determine duration of ${absolutePath}`,
    );
  }

  return metadata.durationInSeconds;
};

export const secondsToFrames = (seconds: number, fps: number): number => {
  return Math.max(1, Math.round(seconds * fps));
};
