/**
 * Kame palette: warm gold + ink. Yellow is a SURFACE colour (buttons, hero card, avatar) with ink
 * text on top. It is never used for text on light backgrounds, where it would be unreadable.
 * Contrast: ink on gold 11.6:1, gold on ink 11.6:1 (WCAG AAA).
 */
export const theme = {
  bg: '#FAFAF7',
  card: '#FFFFFF',
  text: '#111111',
  muted: '#66645E',
  border: '#E7E4DA',
  primary: '#FFC21A',   // Kame gold (surfaces only)
  onPrimary: '#111111', // text/icons on gold
  ink: '#111111',       // links, wordmark, dark surfaces
  onInk: '#FFC21A',     // text/icons on ink
  danger: '#B91C1C',
  positive: '#15803D',
};
