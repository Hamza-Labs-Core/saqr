/**
 * Syntax highlighting theme definitions.
 *
 * @module theme/syntax
 */

import type { SyntaxTheme } from "./types.js";

/**
 * Dark mode syntax highlighting colors.
 * Inspired by One Dark / GitHub Dark.
 */
export const DARK_SYNTAX_THEME: SyntaxTheme = {
  keyword: "#FF7B72",
  string: "#A5D6FF",
  number: "#79C0FF",
  comment: "#8B949E",
  function: "#D2A8FF",
  variable: "#FFA657",
  type: "#FF7B72",
  operator: "#FF7B72",
  punctuation: "#C9D1D9",
  tag: "#7EE787",
  attribute: "#79C0FF",
  regexp: "#A5D6FF",
  constant: "#79C0FF",
  builtin: "#FFA657",
  className: "#F0883E",
  property: "#79C0FF",
};

/**
 * Light mode syntax highlighting colors.
 * Inspired by One Light / GitHub Light.
 */
export const LIGHT_SYNTAX_THEME: SyntaxTheme = {
  keyword: "#CF222E",
  string: "#0A3069",
  number: "#0550AE",
  comment: "#6E7781",
  function: "#8250DF",
  variable: "#953800",
  type: "#CF222E",
  operator: "#CF222E",
  punctuation: "#24292F",
  tag: "#116329",
  attribute: "#0550AE",
  regexp: "#0A3069",
  constant: "#0550AE",
  builtin: "#953800",
  className: "#953800",
  property: "#0550AE",
};
