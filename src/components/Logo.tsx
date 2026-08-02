import React from "react";

export interface LogoProps {
  dark?: boolean;
  iconOnly?: boolean;
  className?: string;
  size?: number;
}

export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`brand-mark ${className}`} style={{ width: size, height: size }}>
      <i />
      <i />
      <i />
    </span>
  );
}

export function Logo({ dark = false, iconOnly = false, className = "" }: LogoProps) {
  return (
    <div className={`brand ${dark ? "on-dark" : ""} ${iconOnly ? "icon-only" : ""} ${className}`}>
      <LogoMark />
      {!iconOnly && <span>GrowthSent</span>}
    </div>
  );
}

export default Logo;
