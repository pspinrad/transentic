/**
 * styling-engine.js
 *
 * Pure, side-effect-free mapping from a word's sentiment vector + the
 * user's Settings-pane configuration -> a concrete CSS style object.
 *
 * Exposed as a global `StylingEngine` for the plain-script renderer.
 */

const StylingEngine = (function (rawSettings) {
  const settings = rawSettings || {
    SENTIMENTS: [], STYLINGS: [],
    min_text_channel: 0, max_text_channel: 128,
    min_bkgnd_channel: 255, max_bkgnd_channel: 210,
    min_font_size: 12, max_font_size: 24,
    min_font_weight: 400, max_font_weight: 900,
    min_underline_gray: 250, max_underline_gray: 0,
    max_forward_slant: 10,
    min_letter_spacing_space_em: 0, max_letter_spacing_space_em: 0.15, max_wdth_space_delta: 51,
    min_letter_spacing_crowd_em: 0, max_letter_spacing_crowd_em: -0.03, max_wdth_crowd_delta: -75,
    max_baseline_bounce_em: 1,
    default_sensitivity: 0.5, sensitivity_gain_multiplier: 2
  };
  const { SENTIMENTS, STYLINGS } = settings;

  // Sentiment pairs treated as semantic opposites. If both are present at
  // once on the same word, rendering both stylings simultaneously reads as
  // contradictory (a word visually styled as both "happy" and "sad" at
  // once) — so only their net difference survives: the smaller of the pair
  // is subtracted from both, leaving one at its net value and the other at
  // exactly 0. E.g. raw Happy=0.5, Sad=0.3 -> Happy=0.2, Sad=0.
  // Extend this list if other pairs turn out to need the same treatment.
  const OPPOSITE_SENTIMENT_PAIRS = [['Happy', 'Sad']];

  function resolveOppositeSentiments(sentimentScores) {
    const resolved = Object.assign({}, sentimentScores);
    OPPOSITE_SENTIMENT_PAIRS.forEach(([a, b]) => {
      const va = resolved[a] || 0;
      const vb = resolved[b] || 0;
      const net = va - vb;
      resolved[a] = Math.max(0, net);
      resolved[b] = Math.max(0, -net);
    });
    return resolved;
  }

  /**
   * @param {Object} sentimentScores - e.g. { Happy: 0.2, Sad: 0.0, ... } each 0-1 raw model output
   * @param {Object} userConfig - { stylingMap: {Sentiment: Styling}, sensitivity: {Sentiment: 0-1} }
   * @returns {Object} { cssStyle: {...}, lineHeightEm: number }
   */
  function computeWordStyle(rawSentimentScores, userConfig) {
    const sentimentScores = resolveOppositeSentiments(rawSentimentScores);
    const { stylingMap, sensitivity } = userConfig;

    // 1. Compute the "effective" (gain-adjusted) 0-1 value for each STYLING,
    //    by looking at every Sentiment currently assigned to it.
    const effectiveByStyling = {};
    STYLINGS.forEach((styling) => {
      const contributingSentiments = SENTIMENTS.filter((s) => stylingMap[s] === styling);
      if (contributingSentiments.length === 0) {
        effectiveByStyling[styling] = 0;
        return;
      }
      const values = contributingSentiments.map((s) => {
        const raw = sentimentScores[s] || 0;
        const gain = (sensitivity[s] != null ? sensitivity[s] : settings.default_sensitivity)
          * settings.sensitivity_gain_multiplier;
        return clamp01(raw * gain);
      });
      // Conflict resolution when >1 Sentiment maps to the same Styling: average.
      const averaged = values.reduce((a, b) => a + b, 0) / values.length;
      // Perceptual response curve: steep near baseline (0), flattening
      // toward 1, so small real differences near neutral read as visibly
      // distinct styling instead of being lost in a near-linear mapping.
      // Set response_curve_k to 0/null in settings to disable and go linear.
      effectiveByStyling[styling] = applyResponseCurve(averaged);
    });

    // 2. Translate each styling's effective value into real CSS.
    const rText = lerp(settings.min_text_channel, settings.max_text_channel, effectiveByStyling['R-text']);
    const gText = lerp(settings.min_text_channel, settings.max_text_channel, effectiveByStyling['G-text']);
    const bText = lerp(settings.min_text_channel, settings.max_text_channel, effectiveByStyling['B-text']);

    // R-bkgnd/G-bkgnd/B-bkgnd each push the background toward an actual
    // pale red/green/blue tint by reducing the *other two* channels while
    // leaving their own channel at full brightness — e.g. R-bkgnd keeps red
    // at 255 and pulls green+blue down, which reads as pale red/pink. (An
    // earlier version instead reduced each styling's own same-named
    // channel, which is subtractive-color logic and visually produces the
    // complementary color instead — R-bkgnd looked cyan, not red. This is
    // the corrected, intuitive version.)
    // If more than one background styling is active on the same word, each
    // output channel takes the MINIMUM (most-reduced) value proposed by
    // whichever stylings affect it, so overlapping effects compound rather
    // than one silently overriding another.
    const eR = effectiveByStyling['R-bkgnd'];
    const eG = effectiveByStyling['G-bkgnd'];
    const eB = effectiveByStyling['B-bkgnd'];
    const reduced = (e) => lerp(settings.min_bkgnd_channel, settings.max_bkgnd_channel, e);
    const rBkgnd = Math.min(reduced(eG), reduced(eB)); // reduced by G-bkgnd and/or B-bkgnd, not by R-bkgnd itself
    const gBkgnd = Math.min(reduced(eR), reduced(eB));
    const bBkgnd = Math.min(reduced(eR), reduced(eG));

    const fontSizePt = lerp(settings.min_font_size, settings.max_font_size, effectiveByStyling['Size']);
    const fontWeight = Math.round(lerp(settings.min_font_weight, settings.max_font_weight, effectiveByStyling['Weight']));

    const underlineGray = Math.round(lerp(settings.min_underline_gray, settings.max_underline_gray, effectiveByStyling['Underline']));

    // Forward-slant now uses the font's own native `slnt` variation axis
    // (via the standard font-style: oblique <angle> property) instead of a
    // CSS transform. A transform paints outside the element's actual box —
    // that's what caused slanted words to visually spill into neighbors
    // and confuse click/selection hit-testing. font-style: oblique reshapes
    // the glyphs themselves within their normal metrics, so it reflows
    // and hit-tests correctly with zero special-case handling needed.
    // Per the CSS spec, a POSITIVE oblique angle here maps to the font's
    // conventional right-leaning (negative) slnt value internally.
    const forwardDeg = lerp(0, settings.max_forward_slant, effectiveByStyling['Forward-slant']);

    // Space-letters / Crowd-letters: an earlier "Backward-slant" styling
    // used the same risky transform approach as Forward-slant and was
    // retired for reading room. These two replace it — Space-letters
    // widens tracking and stretches the font wider; Crowd-letters tightens
    // tracking and condenses it narrower. Both are ordinary box-affecting
    // properties (letter-spacing, font-stretch), so they reflow normally
    // like Size does, with no transform/hit-testing risk at all.
    // If both are active at once (different sentiments mapped to each),
    // their deltas simply sum — since one pushes positive and the other
    // negative, this naturally nets out rather than needing an explicit
    // opposite-pair cancellation rule.
    const spaceEffective = effectiveByStyling['Space-letters'];
    const crowdEffective = effectiveByStyling['Crowd-letters'];
    const letterSpacingEm =
      lerp(settings.min_letter_spacing_space_em, settings.max_letter_spacing_space_em, spaceEffective) +
      lerp(settings.min_letter_spacing_crowd_em, settings.max_letter_spacing_crowd_em, crowdEffective);
    const wdthDelta =
      lerp(0, settings.max_wdth_space_delta, spaceEffective) +
      lerp(0, settings.max_wdth_crowd_delta, crowdEffective);
    const wdthPercent = Math.max(25, Math.min(151, 100 + wdthDelta)); // clamp to Roboto Flex's actual wdth range

    const bounceEm = settings.max_baseline_bounce_em * effectiveByStyling['Baseline-bounce'];

    const cssStyle = {
      color: `rgb(${rText}, ${gText}, ${bText})`,
      backgroundColor: `rgb(${rBkgnd}, ${gBkgnd}, ${bBkgnd})`,
      fontSize: `${fontSizePt}pt`,
      fontWeight: String(fontWeight),
      fontStyle: forwardDeg > 0 ? `oblique ${formatSmallNumber(forwardDeg)}deg` : 'normal',
      fontStretch: `${formatSmallNumber(wdthPercent)}%`,
      letterSpacing: `${formatSmallNumber(letterSpacingEm)}em`,
      textDecorationLine: 'underline',
      textDecorationColor: `rgb(${underlineGray}, ${underlineGray}, ${underlineGray})`,
      textDecorationThickness: '2px',
      transform: `translateY(${formatSmallNumber(-bounceEm)}em)`,
      display: 'inline-block'
    };

    // 3. Compute how tall this word's line needs to be to avoid clipping/overlap:
    //    base line height + bounce offset + a little headroom for size/underline.
    const baseLineHeightEm = fontSizePt / settings.min_font_size; // scales with size relative to min
    const lineHeightEm = baseLineHeightEm + bounceEm + 0.15;

    return { cssStyle, lineHeightEm, effectiveByStyling };
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * clamp01(t);
  }

  // f(x) = ln(1 + k*x) / ln(1 + k): a concave curve from (0,0) to (1,1).
  // Steep slope near x=0 means small raw sentiment differences near
  // baseline get stretched into visibly distinct styling; the flattening
  // slope near x=1 means already-strong signals don't need to (and don't)
  // grow much further. k=0 (or falsy) disables this and returns x unchanged.
  function applyResponseCurve(x) {
    const k = settings.response_curve_k;
    if (!k || k <= 0) return clamp01(x);
    return clamp01(Math.log(1 + k * x) / Math.log(1 + k));
  }

  // Rounds to 3 decimal places and snaps anything below that resolution to
  // exactly 0, avoiding scientific-notation noise (e.g. "7e-08") in inline
  // styles for values that are visually indistinguishable from zero anyway.
  function formatSmallNumber(n) {
    const rounded = Math.round(n * 1000) / 1000;
    return rounded === 0 ? '0' : rounded.toFixed(3);
  }

  return { computeWordStyle };
})(window.APP_SETTINGS);
