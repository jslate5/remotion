import React from "react";
import { AbsoluteFill, Series, staticFile } from "remotion";
import { Video } from "@remotion/media";
import type { ShortFormProps } from "./schema";

// If the src looks like a plain path ("clips/foo.mp4") resolve it via staticFile().
// If it's already an absolute URL or a file:// URL, pass it through unchanged.
const resolveClipSrc = (src: string): string => {
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("file://") ||
    src.startsWith("/")
  ) {
    return src;
  }
  return staticFile(src);
};

export const ShortForm: React.FC<ShortFormProps> = ({ clips }) => {
  if (clips.length === 0) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "black",
          color: "white",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
          fontSize: 48,
          padding: 40,
          textAlign: "center",
        }}
      >
        No clips in this plan. Run `npm run plan` to generate one.
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Series>
        {clips.map((clip, index) => (
          <Series.Sequence
            key={`${index}-${clip.src}`}
            durationInFrames={clip.durationInFrames}
          >
            <Video
              src={resolveClipSrc(clip.src)}
              objectFit="cover"
              style={{
                width: "100%",
                height: "100%",
              }}
            />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};
