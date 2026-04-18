import "./index.css";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { HelloWorld, myCompSchema } from "./HelloWorld";
import { Logo, myCompSchema2 } from "./HelloWorld/Logo";
import {
  ShortForm,
  ShortFormSchema,
  SHORT_FORM_FPS,
  SHORT_FORM_WIDTH,
  SHORT_FORM_HEIGHT,
  type ShortFormProps,
} from "./ShortForm";

// Sum per-clip durations. All clips arrive with durationInFrames pre-computed
// during ingest, so this is a pure, fast reducer.
const shortFormMetadata: CalculateMetadataFunction<ShortFormProps> = ({
  props,
}) => {
  const total = props.clips.reduce(
    (sum, clip) => sum + clip.durationInFrames,
    0,
  );

  // Remotion requires durationInFrames >= 1. Provide a 1-frame placeholder so
  // Studio can still render the "no clips" message instead of crashing.
  return {
    durationInFrames: Math.max(1, total),
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ShortForm"
        component={ShortForm}
        schema={ShortFormSchema}
        durationInFrames={1}
        fps={SHORT_FORM_FPS}
        width={SHORT_FORM_WIDTH}
        height={SHORT_FORM_HEIGHT}
        defaultProps={{
          clips: [],
        }}
        calculateMetadata={shortFormMetadata}
      />

      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema}
        defaultProps={{
          titleText: "Welcome to Remotion",
          titleColor: "#000000",
          logoColor1: "#91EAE4",
          logoColor2: "#86A8E7",
        }}
      />

      <Composition
        id="OnlyLogo"
        component={Logo}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema2}
        defaultProps={{
          logoColor1: "#91dAE2" as const,
          logoColor2: "#86A8E7" as const,
        }}
      />
    </>
  );
};
