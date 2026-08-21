/**
 * Mermaid's palette, derived from the app's own design tokens.
 *
 * Kept as a pure function of a token reader rather than reading `document`
 * directly, so the exact object that ships can be produced outside a browser —
 * a themed diagram is only verifiable by rendering it, and a test harness that
 * re-declares the config tests something other than what runs.
 */

/**
 * Categorical fills for the diagrams that colour by series — pie, journey,
 * timeline, mindmap, gitGraph.
 *
 * These cannot come from the app's tokens: mermaid derives its series ramps
 * from primaryColor/secondaryColor/tertiaryColor, and this theme's surfaces are
 * three shades of the same charcoal, so every slice came out the same
 * near-black. The hues below are spaced around the wheel at a single lightness
 * so they stay distinguishable from each other and legible on a dark ground,
 * and the ramp opens on the app's coral so a small chart still reads as part of
 * the app.
 */
export const SERIES = [
  '#ec8b84', // coral (--primary)
  '#6fc3b8', // teal
  '#8ea4e8', // periwinkle
  '#e3b364', // amber
  '#b98fd0', // mauve
  '#93c47d', // sage
  '#6fb4d6', // sky
  '#d98aa8', // rose
];

/** `{pie1: …, pie2: …}`-style maps, since mermaid takes series colours as
 *  numbered scalar keys rather than an array. */
function seriesVars(prefix: string, from = 1): Record<string, string> {
  return Object.fromEntries(SERIES.map((c, i) => [`${prefix}${i + from}`, c]));
}

/** Resolves a CSS custom property name to a colour, or '' when unset. */
export type TokenReader = (name: string) => string;

export function mermaidThemeVariables(read: TokenReader): Record<string, unknown> {
  const bg = read('--card') || '#12161f';
  const surface = read('--secondary') || '#262c38';
  const muted = read('--muted') || '#242a35';
  const text = read('--foreground') || '#d5dae2';
  const line = read('--muted-foreground') || '#868e9e';
  const accent = read('--primary') || '#ec8b84';
  const border = read('--input') || '#333b4a';

  return {
    darkMode: true,
    background: bg,

    // Flowchart / generic nodes
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: accent,
    secondaryColor: muted,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: bg,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    mainBkg: surface,
    nodeBorder: accent,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    // theme-base defaults this to black, and it is what state-diagram node
    // labels are painted with — left alone, every state box renders empty.
    labelColor: text,
    lineColor: line,
    edgeLabelBackground: bg,
    clusterBkg: muted,
    clusterBorder: border,
    classText: text,

    // Sequence diagrams
    actorBkg: surface,
    actorBorder: accent,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: accent,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: muted,
    noteTextColor: text,
    noteBorderColor: border,
    activationBkgColor: muted,
    activationBorderColor: accent,
    sequenceNumberColor: bg,

    // State diagrams
    stateBkg: surface,
    stateBorder: accent,
    stateLabelColor: text,
    transitionColor: line,
    transitionLabelColor: text,
    labelBackgroundColor: bg,
    altBackground: muted,
    compositeBackground: bg,
    compositeBorder: border,
    compositeTitleBackground: muted,

    // Pie. Section labels sit on top of a SERIES fill, so they take the dark
    // background rather than the light body text.
    pieTitleTextColor: text,
    pieSectionTextColor: bg,
    pieLegendTextColor: text,
    pieStrokeColor: bg,
    pieOuterStrokeColor: border,
    ...seriesVars('pie'),

    // journey / timeline / mindmap ramps, and their on-fill label colour.
    ...seriesVars('cScale', 0),
    ...Object.fromEntries(SERIES.map((_, i) => [`cScaleLabel${i}`, bg])),

    // xychart reads a nested object rather than flat keys, so it ignores every
    // variable above — left out, its plot area renders cream-on-dark.
    xyChart: {
      backgroundColor: bg,
      titleColor: text,
      xAxisLabelColor: text,
      xAxisTitleColor: text,
      xAxisTickColor: line,
      xAxisLineColor: line,
      yAxisLabelColor: text,
      yAxisTitleColor: text,
      yAxisTickColor: line,
      yAxisLineColor: line,
      plotColorPalette: SERIES.join(', '),
    },

    // gitGraph branch colours, with commit labels on top of them.
    ...seriesVars('git', 0),
    ...Object.fromEntries(SERIES.map((_, i) => [`gitBranchLabel${i}`, bg])),
    gitInv0: bg,
    commitLabelColor: text,
    commitLabelBackground: bg,
  };
}

/**
 * Everything passed to `mermaid.initialize()`. Split out alongside the palette
 * so the whole config is verifiable in one import.
 */
export function mermaidConfig(read: TokenReader, fontFamily: string) {
  return {
    startOnLoad: false,
    // The diagram is model-authored text: sanitize it. `strict` runs labels
    // through DOMPurify and disables `click` directives.
    securityLevel: 'strict' as const,
    // Render our own failure surface instead of letting mermaid inject its
    // error graphic into a stray element it leaves attached to <body>.
    suppressErrorRendering: true,
    theme: 'base' as const,
    themeVariables: mermaidThemeVariables(read),
    fontFamily,
    fontSize: 13,
    flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis' as const },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  };
}
