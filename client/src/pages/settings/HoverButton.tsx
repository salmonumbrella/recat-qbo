// Button with a JS-driven hover style — used where the prototype declares a
// style-hover on an element whose inline styles must be reproduced verbatim
// (declaration order matters: several buttons end with `font:inherit`, which
// resets earlier font-size/weight exactly as it does in the prototype).

import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties } from 'react';

export default function HoverButton({
  hoverStyle,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { hoverStyle?: CSSProperties }) {
  const [hover, setHover] = useState(false);
  const unavailable =
    rest.disabled || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      {...rest}
      onMouseEnter={() => {
        if (!unavailable) setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      style={hover && !unavailable && hoverStyle ? { ...style, ...hoverStyle } : style}
    />
  );
}
