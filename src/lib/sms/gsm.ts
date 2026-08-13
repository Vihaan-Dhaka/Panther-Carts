const GSM_BASIC = new Set(
  "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0".split(
    "",
  ),
);
const GSM_EXTENSION = new Set("\f^{}\\[~]|\u20ac".split(""));

export type SmsSegmentAnalysis =
  | { encoding: "GSM-7"; units: number; segments: number }
  | { encoding: "UCS-2"; units: number; segments: number };

/** Count GSM septets (extension characters cost two) or UTF-16 UCS-2 units. */
export function analyzeSmsSegments(body: string): SmsSegmentAnalysis {
  let septets = 0;
  for (const character of body) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENSION.has(character)) septets += 2;
    else {
      const units = body.length;
      return {
        encoding: "UCS-2",
        units,
        segments: units <= 70 ? 1 : Math.ceil(units / 67),
      };
    }
  }

  return {
    encoding: "GSM-7",
    units: septets,
    segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}

export function assertSingleGsm7Segment(body: string): void {
  const analysis = analyzeSmsSegments(body);
  if (analysis.encoding !== "GSM-7" || analysis.segments !== 1) {
    throw new Error("SMS template must fit in one GSM-7 segment");
  }
}
