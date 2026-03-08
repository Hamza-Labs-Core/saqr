/** Layout constants for the mobile app. */
export const LAYOUT = {
  /** Standard horizontal padding for screens. */
  screenPaddingH: 16,
  /** Standard vertical padding for screens. */
  screenPaddingV: 12,
  /** Border radius for cards. */
  cardRadius: 12,
  /** Border radius for buttons. */
  buttonRadius: 8,
  /** Border radius for inputs. */
  inputRadius: 10,
  /** Standard icon size. */
  iconSize: 24,
  /** Small icon size. */
  iconSizeSm: 16,
  /** Large icon size. */
  iconSizeLg: 32,
  /** Status dot diameter. */
  statusDotSize: 10,
  /** Minimum touch target. */
  minTouchTarget: 44,
} as const;

/** Timing constants for the mobile app. */
export const TIMING = {
  /** Agent list polling interval in ms. */
  agentPollInterval: 5000,
  /** Session list polling interval in ms. */
  sessionPollInterval: 10000,
  /** Usage data polling interval in ms. */
  usagePollInterval: 30000,
  /** WebSocket reconnect base delay in ms. */
  wsReconnectBaseDelay: 1000,
  /** Maximum WebSocket reconnect delay in ms. */
  wsReconnectMaxDelay: 60000,
  /** Debounce delay for search input in ms. */
  searchDebounce: 300,
  /** Animation duration for transitions in ms. */
  animationDuration: 200,
} as const;

/** Session history page size. */
export const PAGE_SIZE = 20;
